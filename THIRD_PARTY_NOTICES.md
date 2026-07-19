# Third-party notices

Harbor is distributed under the MIT License. Its npm dependencies retain their
own licenses and copyright notices. The corresponding package metadata and
license files are available in each package published through the npm registry.

The direct runtime dependencies used by Harbor are licensed under permissive
open-source licenses, principally MIT. Notable exceptions and attribution-bearing
assets are listed below.

## Bundled fonts

Harbor bundles these fonts through Fontsource under the SIL Open Font License
1.1:

- Big Shoulders — copyright 2019 The Big Shoulders Project Authors
- Fraunces — copyright 2020 The Fraunces Project Authors
- JetBrains Mono — copyright 2020 The JetBrains Mono Project Authors

The complete license shipped with the application is available at
`/licenses/OFL-1.1.txt` and in `web/public/licenses/OFL-1.1.txt` in the source.

## Optional example images

The ntfy example references the version-and-digest-pinned
`binwiederhier/ntfy:v2.23.0` image. ntfy is not bundled in the Harbor image and
remains a separate project dual-licensed under Apache License 2.0 and GPLv2. See
<https://github.com/binwiederhier/ntfy>.

The SMS relay example is Harbor-owned source and is covered by Harbor's MIT License.

## Development-only quality tools

The Axe accessibility test packages are licensed under MPL-2.0. Several
transitive ESLint parser packages are licensed under BSD-2-Clause. These tools
are used only while developing and testing Harbor; they and their source code
are not included in the production container image. Both license families were
reviewed and accepted for this development-only use.

## Dependency license inventory

Before each release, run `npm run licenses:check` and review the generated
dependency tree. A release must not proceed if a dependency has an unknown,
copyleft, source-available, or otherwise incompatible license until its intended
use has been reviewed and this notice and allowlist have been updated.
