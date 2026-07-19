# Optional notification helpers

These examples are opt-in services. They are not built into the Harbor image and
do not start with Harbor's default Compose file.

| Example | Purpose | Harbor support |
|---|---|---|
| [ntfy](ntfy/) | Self-hosted phone and desktop push using the official ntfy image | Per-user endpoints under Account → Private phone push |
| [SMS relay](sms-relay/) | Harbor-owned authenticated SignalWire-compatible SMS gateway | Standalone helper; native Harbor SMS delivery is not implemented yet |

Both examples are private by default, require explicit credentials, and attach to
an existing Harbor Docker network. Review the example's README before starting it.
Do not publish either service directly to the internet without an HTTPS reverse
proxy and an additional access-control layer.
