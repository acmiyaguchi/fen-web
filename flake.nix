{
  description = "fen-web: browser-resident form of fen";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    # Source of the newer busted only; see the lua54Packages overlay below.
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, flake-utils }:
    flake-utils.lib.eachSystem [
      "x86_64-linux"
      "aarch64-linux"
    ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          # Override only busted (test-only) with unstable's newer release,
          # which ships the fennel busted loader missing from 25.11's lua54
          # busted. busted never enters a shipped artifact, so this is safe.
          overlays = [
            (_final: prev: {
              lua54Packages = prev.lua54Packages // {
                inherit (nixpkgs-unstable.legacyPackages.${system}.lua54Packages) busted;
              };
            })
          ];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            lua5_4
          ] ++ (with pkgs.lua54Packages; [
            fennel
            busted
            lua-cjson
          ]);
        };
      });
}
