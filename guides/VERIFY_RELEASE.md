# Verify a Harbor release

Harbor release images are published to GitHub Container Registry with an SPDX
software bill of materials, BuildKit provenance, and a keyless Sigstore signature.
Use an immutable digest from the corresponding GitHub release whenever possible.

After installing `cosign`, verify that the image was signed by Harbor's release
workflow:

```bash
cosign verify \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  --certificate-identity-regexp='^https://github.com/OWNER/harbor/.github/workflows/release.yml@refs/tags/v' \
  ghcr.io/OWNER/harbor@sha256:RELEASE_DIGEST
```

Replace `OWNER` and `RELEASE_DIGEST` with the repository owner and digest printed
in the GitHub release. A locally rebuilt image or floating tag is not the signed
release artifact, even when it was built from the same source commit.
