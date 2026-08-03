# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/bircni/actions-visualizer-extension/compare/v0.1.0..v0.2.0) - 2026-08-03

### Added

- **(expression)** decide the status functions from the run, not a constant - ([c7cb0eb](https://github.com/bircni/actions-visualizer-extension/commit/c7cb0ebd4ddf471f652ad0d3518dbe26b78bc5ea))
- **(parse)** keep step ids, run scripts and output expressions - ([5e00d0c](https://github.com/bircni/actions-visualizer-extension/commit/5e00d0c48e3a530b59447da5f8cfda2206104a26))
- **(preview)** drive a playthrough from the controller - ([74e5c1d](https://github.com/bircni/actions-visualizer-extension/commit/74e5c1d94caa453d627038ea09efb1b99fb9823d))
- **(webview)** render the playthrough - ([b15d3ac](https://github.com/bircni/actions-visualizer-extension/commit/b15d3ac8443d9e5ba5449af18d2791e34f81f96f))
- **(workflow)** discover the outputs a step produces - ([64163c1](https://github.com/bircni/actions-visualizer-extension/commit/64163c1b947234fb2e757b13c32073a03f30fc40))
- **(workflow)** add the playthrough engine - ([851bea7](https://github.com/bircni/actions-visualizer-extension/commit/851bea7f8ee42bec6214a08f179c27da1f5df552))

### Changed

- **(preview)** assemble the graph message in one place - ([56058a4](https://github.com/bircni/actions-visualizer-extension/commit/56058a4e1fe970113525cc6ac3445ba9bc97fcf3))
- describe playthrough mode - ([75fb8bd](https://github.com/bircni/actions-visualizer-extension/commit/75fb8bd8d347c82fbca661b101502957df583f83))

### Fixed

- **(simulate)** stop a pin from clobbering the context it lands in - ([1f343c4](https://github.com/bircni/actions-visualizer-extension/commit/1f343c444866298a213defeb185de768c37a3d1d))

## [0.1.0] - 2026-08-03

### Added

- **(assets)** add a workflow graph icon - ([c7fe24d](https://github.com/bircni/actions-visualizer-extension/commit/c7fe24d39cdad659cea430963bde2a92dd937ec0))
- **(preview)** follow the active editor - ([009eefb](https://github.com/bircni/actions-visualizer-extension/commit/009eefb6ac7d03305a181ed2c8720a69f82b0b38))
- **(preview)** let the user pin values the simulation cannot know - ([33cbee9](https://github.com/bircni/actions-visualizer-extension/commit/33cbee98eb62920c97a1d667c700ba2b9d113c48))
- **(preview)** report workflow problems as editor diagnostics - ([5328bec](https://github.com/bircni/actions-visualizer-extension/commit/5328bec97096f2f6c7083ca81e383b18f3f72bf6))
- **(simulate)** evaluate step conditions and scope contexts correctly - ([e38a744](https://github.com/bircni/actions-visualizer-extension/commit/e38a744359c3b0aca11d79a93166eeef41672b8c))
- **(simulate)** honour branch and tag filters - ([72f159e](https://github.com/bircni/actions-visualizer-extension/commit/72f159efdd8413bbdd7eed877c764401434254dd))
- **(webview)** add keyboard navigation and screen reader support - ([24cf57e](https://github.com/bircni/actions-visualizer-extension/commit/24cf57e044ed8c5fe7336986fde2ab1845acfa99))
- visualize GitHub and Gitea Actions workflows as a graph - ([01e55ec](https://github.com/bircni/actions-visualizer-extension/commit/01e55ecddaedbd2747d94b40a0cfd1b7b29b626d))

### Changed

- describe simulation depth, filters and keyboard access - ([45dbd05](https://github.com/bircni/actions-visualizer-extension/commit/45dbd0582c821edd3fe251c4a745ddf7e68a99e3))
- add a screenshot and restructure the README - ([8c98a36](https://github.com/bircni/actions-visualizer-extension/commit/8c98a36dbc4dd4cdcef954f2828d05f30e6b1f76))

### Fixed

- **(release)** allow a first release when the version already matches - ([d8df4d0](https://github.com/bircni/actions-visualizer-extension/commit/d8df4d0884ecf5c320f3afe53fe34cf007a3c3f1))

### Internal

- **(ci)** disable Open VSX publishing until a token is configured - ([9f54a07](https://github.com/bircni/actions-visualizer-extension/commit/9f54a07ff123402efd2c6de5a34f5958e8383a7c))
