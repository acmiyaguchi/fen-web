;; Browser-native tool_search, ported from fen's registry-generic builtin.
;;
;; The web agent still owns a complete executable `ctx.agent.tools` registry;
;; only provider exposure differs. Searching :search tools and recording names
;; in `agent.active-tool-names` therefore needs no desktop-only filesystem or
;; process infrastructure.

(local types (require :fen.core.types))
(local text (. (require :fen.util.text) :trim))

(fn words [s]
  (let [out []]
    (each [word (string.gmatch (string.lower (tostring (or s ""))) "[%w_%-]+")] 
      (table.insert out word))
    out))

(local STOP-WORDS {:a true :an true :for true :the true :tool true :to true})

(fn meaningful-words [query]
  (let [out []]
    (each [_ word (ipairs (words query))]
      (when (not (. STOP-WORDS word))
        (table.insert out word)))
    out))

(fn searchable-text [tool]
  (string.lower
    (table.concat [(tostring (or tool.name ""))
                   (tostring (or tool.label ""))
                   (tostring (or tool.snippet ""))
                   (tostring (or tool.description ""))
                   (tostring (or tool.__owner ""))]
                  " ")))

(fn score [tool query query-words]
  (let [name (string.lower (tostring (or tool.name "")))
        haystack (searchable-text tool)
        total (length query-words)]
    (var matched 0)
    (var name-matches 0)
    (each [_ word (ipairs query-words)]
      (when (string.find haystack word 1 true)
        (set matched (+ matched 1))
        (when (string.find name word 1 true)
          (set name-matches (+ name-matches 1)))))
    (if (and (> total 0) (= matched total))
        (+ (* matched 100) (* name-matches 20)
           (if (= name query) 1000
               (string.find name query 1 true) 100
               (string.find haystack query 1 true) 20
               0))
        0)))

(fn result [body error? details]
  {:content [(types.text-block body)]
   :is-error? (or error? false)
   :details details})

(fn execute [args ctx]
  (let [query (string.lower (text (or args.query "")))
        agent (?. ctx :agent)]
    (if (= query "")
        (result "query must not be empty" true nil)
        (not agent)
        (result "tool_search requires an agent context" true nil)
        (let [query-words (meaningful-words query)
              hits []
              active (or agent.active-tool-names {})
              limit (math.max 1 (math.min 10 (math.floor (or (tonumber args.limit) 5))))]
          (set agent.active-tool-names active)
          (each [_ tool (ipairs (or agent.tools []))]
            (when (and (= tool.exposure :search)
                       (not (= (tostring tool.name) "tool_search")))
              (let [rank (score tool query query-words)]
                (when (> rank 0)
                  (table.insert hits {:tool tool :score rank})))))
          (table.sort hits
                      (fn [a b]
                        (if (= a.score b.score)
                            (< (tostring a.tool.name) (tostring b.tool.name))
                            (> a.score b.score))))
          (let [activated []
                lines []]
            (each [i hit (ipairs hits)]
              (when (<= i limit)
                (let [tool hit.tool
                      name (tostring tool.name)]
                  (tset active name true)
                  (table.insert activated name)
                  (table.insert lines
                                (.. "- " name " — "
                                    (tostring (or tool.snippet
                                                  tool.description
                                                  "")))))))
            (if (= (length activated) 0)
                (result (.. "No tools matched: " query) false
                        {:query query :activated []})
                (result (.. "Activated tools for subsequent requests:\n"
                            (table.concat lines "\n"))
                        false
                        {:query query :activated activated})))))))

{:name :tool_search
 :label "Tool Search"
 :snippet "Find and activate specialized tools"
 :description "Search registered specialized tools by capability. Matching tools are activated and their schemas become available on the next model request. Browser file/workspace tools are already available."
 :parameters {:type :object
              :properties {:query {:type :string
                                   :description "Capability or tool name to search for"}
                           :limit {:type :integer
                                   :minimum 1
                                   :maximum 10
                                   :description "Maximum tools to activate (default 5)"}}
              :required [:query]}
 :execute execute}
