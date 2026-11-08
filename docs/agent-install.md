# Install Mote with a Coding Agent

This guide is for an Agent helping someone install and connect Mote. It reuses the existing deployment CLI; it is not a request to develop Mote or an authorization to replace an existing archive. For repository development use [AGENTS.md](../AGENTS.md).

Mote has an independent Central service and macOS/Android collectors. Central archives and processes context; collectors own device permissions and local collection. A local Central install needs no screen, microphone, calendar or Accessibility permission. Model setup and external MCP connections are optional after the first data journey.

## Copy this prompt

```text
Help me install Mote from https://github.com/utopiafar/mote.
Read docs/agent-install.md and the linked deployment instructions first.
Inspect my environment and any existing Mote installation without changing it.
Use the project's CLI to create an isolated local trial, or reuse the installation
I explicitly choose. Preserve existing archives, profiles, credentials and settings.
Verify authenticated health and give me the actual Central address, then guide me
through connecting a collector and opening its first received original in Central.
Ask before changing network exposure, installing a persistent service, granting
new permissions, using a paid model, or changing existing data. Keep secrets out
of output and Git. Stop at an unavailable requirement and report what remains.
```

The installation request authorizes ordinary setup for the selected environment. It does not authorize a public listener, firewall/DNS change, Tunnel, privileged service, credential replacement, archive reset, migration, deletion or paid AI processing. Complete independent safe steps while a consequential decision is pending.

## 1. Discover the environment

Inspect OS/architecture, Node/npm versions, available disk space, the selected checkout, existing profile locations and occupied ports. Read [deployment](deployment.md), [connections](connections.md) and the CLI help in the actual checkout. Check package engines and the lockfile rather than inventing dependency versions or install commands.

If Mote already exists, first identify its checkout, explicit `--profile` and `--home`, runtime, data location and process owner. Use its existing CLI `status` without printing configuration secrets. A healthy instance can be handed back to the user; do not clone another instance, stop it, initialize over it, switch its target, or treat its archive as disposable. Old or unsupported formats remain intact and are reported; this guide does not authorize automatic conversion or reset.

For a new trial, use a new private directory and explicit dev profile. For a daily archive, confirm the destination and use a durable home outside the checkout. If the default port is occupied, select another free port for the new profile; never stop the occupant. Do not change ambient `HOME` or reuse a different profile's credentials.

## 2. Use the existing deployment path

On macOS/Linux with Node.js 24 or newer, the native path is the simplest local trial. From a new checkout:

```sh
git clone https://github.com/utopiafar/mote.git
cd mote
npm ci
npm run build:central
node scripts/mote.mjs --help
```

Set `MOTE_INSTALL_HOME` to the new absolute private profile parent you selected; it must not be another installation's home. The following creates `<MOTE_INSTALL_HOME>/dev/` and fails if that profile already exists:

```sh
node scripts/mote.mjs init --profile dev --home "$MOTE_INSTALL_HOME"
```

Use the same explicit home/profile on every subsequent command. When necessary, choose the free port with `init --port N`. Do not silently switch to prod, import real files, or enable capture to make the installation appear complete.

Before the first `start`, review the new profile's private `mote.yaml` locally. New profiles are initialized without a model, so an archive-only trial does not contact a model provider; do not add a model or start model processing without the user's explicit authorization of data scope and possible usage/cost. Keep `models` empty and do not copy model profiles, credentials or embedding settings from another installation. For an existing installation, inspect its actual assignments and use its existing user-approved controls instead. If any effective processing service can still send content to a model, stop before adding data until that path is disabled or authorized. Memory pause alone does not stop independently configured reviews or other processing.

Then start and verify this selected profile:

```sh
node scripts/mote.mjs start --profile dev --home "$MOTE_INSTALL_HOME"
node scripts/mote.mjs status --profile dev --home "$MOTE_INSTALL_HOME"
```

Check the actual model/module settings before the first record; unconfigured AI must remain unconfigured. Do not run a provider connection test to establish this, because the test itself may call a paid service. The user can later configure and authorize AI separately in settings.

For Linux/NAS Docker, follow the [Docker path](deployment.md#linux--nas-docker) instead. Check Docker Engine/Compose requirements, use the pinned project build and private profile, and verify the configured volume is new or explicitly selected. Native and Docker are deployment choices for the same Central service; do not run two writers against one archive.

The first local OCR/audio worker setup may need Python, FFmpeg, network access and explicit model installation. A missing optional processing runtime does not mean the saved original was lost. Report its actual readiness separately; do not silently download large models or enable paid processing to finish onboarding.

## 3. Verify and hand over Central

`start` waits for authenticated health; confirm `status` reports `healthy: true` and the expected profile/runtime/address. A PID or open port alone is insufficient. If health fails, inspect that profile's bounded logs privately, report the failing step and preserve the profile. Never substitute another healthy service or reset data to fix a startup error.

Open the actual returned Central URL. Keep the default loopback binding for a local trial. Sign in through the existing owner login. The CLI `token` command intentionally prints an owner credential: use it only in a private local handoff when needed, never in an issue, PR, screenshot, transcript summary, shell command argument or committed file. Do not copy a token from another environment or change token protection.

A phone cannot reach the Mac's loopback address. Cross-device use requires a reachable HTTPS address and a strong token. Explain the current limitation and let the user choose an existing secure address or explicitly authorize a documented network setup. Generating an invitation or QR code does not create reachability. Installing launchd, enabling TLS/Tunnel or changing network access is a separate explicit step, not a hidden dependency of this guide.

## 4. Continue in the UI

1. In Central, open **Data sources → Connect device**. Use an address the collector can actually reach. The current pairing page can be opened directly at `#/connections/pair`.
2. Obtain the matching existing macOS/Android app from the [official downloads](https://github.com/utopiafar/mote/releases). Follow [Mac](desktop.md) or [Android](android.md) instructions. Do not build or publish a new release just to install it.
3. Prepare/import the invitation privately. The user checks the destination and completes pairing on the device. Invitation creation, redemption and subsequent uploads are distinct results.
4. Let the user choose a source and confirm its reading range, upload destination, original retention and optional description/attribution metadata. System permission prompts remain on the device; do not grant broader permissions automatically.
5. Save a small non-sensitive test record or collect content explicitly selected for this test. Verify local durable save, actual upload acknowledgement, and the same record's readable original in Central. Respect existing send policies and paused states; do not switch them to force success.

No AI key or external MCP client is required for these steps. Local records remain usable offline; an unavailable connection is reported as waiting rather than completed. If the user only wants a local trial without a collector, verify Central and a generated web note, and explicitly report that the collector-to-Central journey is still pending.

## 5. Report actual outcomes

Give a compact handoff containing:

- The selected checkout and explicit profile/home/runtime, actual Central URL and authenticated health result.
- Where data is stored and the exact stop/status commands for this profile; never include credentials.
- Collector pairing, local save, upload ACK and Central original-read results separately, with the stable record identity when available.
- Optional runtime/model gaps, network limits and the next UI action. Do not call an issued invitation, queued upload or successful model test a completed first-data journey.

For an interrupted or refused step, state the exact action and target, reason, completed work, and whether the result is pending, denied or uncertain. Check an uncertain outcome before retrying. Leave existing data and access settings intact.
