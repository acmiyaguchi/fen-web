// Starter todo app seeded into the virtual FS on first load (fen-web#9).
//
// Deliberately dependency-free vanilla JS: the preview iframe runs with
// sandbox="allow-scripts" and NO allow-same-origin (docs/apps/web.md), so
// there is no network reach and no localStorage — state lives in memory for
// the life of the preview. That is exactly the shape the preview.* tools
// drive: the agent fills #new-todo, clicks #add-todo, and asserts the
// rendered list with preview.query.

(function () {
  "use strict";

  /** @type {{ id: number, text: string, done: boolean }[]} */
  const todos = [];
  let nextId = 1;

  const form = document.getElementById("new-todo-form");
  const input = document.getElementById("new-todo");
  const list = document.getElementById("todo-list");
  const emptyState = document.getElementById("empty-state");
  const remainingCount = document.getElementById("remaining-count");

  function addTodo(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    todos.push({ id: nextId++, text: trimmed, done: false });
    render();
  }

  function toggleTodo(id) {
    const todo = todos.find((t) => t.id === id);
    if (todo) {
      todo.done = !todo.done;
      render();
    }
  }

  function removeTodo(id) {
    const index = todos.findIndex((t) => t.id === id);
    if (index !== -1) {
      todos.splice(index, 1);
      render();
    }
  }

  function render() {
    list.replaceChildren();
    for (const todo of todos) {
      const li = document.createElement("li");
      li.dataset.id = String(todo.id);
      if (todo.done) li.classList.add("done");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = todo.done;
      checkbox.setAttribute("aria-label", "Toggle " + todo.text);
      checkbox.addEventListener("change", () => toggleTodo(todo.id));

      const span = document.createElement("span");
      span.className = "todo-text";
      span.textContent = todo.text;

      const del = document.createElement("button");
      del.type = "button";
      del.className = "delete";
      del.textContent = "✕";
      del.setAttribute("aria-label", "Delete " + todo.text);
      del.addEventListener("click", () => removeTodo(todo.id));

      li.append(checkbox, span, del);
      list.append(li);
    }

    const remaining = todos.filter((t) => !t.done).length;
    remainingCount.textContent = String(remaining);
    emptyState.classList.toggle("hidden", todos.length > 0);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    addTodo(input.value);
    input.value = "";
    input.focus();
  });

  // Expose the model for preview.eval-driven assertions/automation.
  window.todoApp = {
    add: addTodo,
    toggle: toggleTodo,
    remove: removeTodo,
    get todos() {
      return todos.map((t) => ({ ...t }));
    },
  };

  render();
})();
