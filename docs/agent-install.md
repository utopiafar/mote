# Install Mote with a Coding Agent

Mote has an independent Central and Mac/Android clients. Start with a local Central and a readable saved note or selected file. A local Central needs no screen, microphone, calendar or Accessibility permission; AI, device capture and cross-device access are optional.

## Copy this prompt

```text
Help me install Mote from https://github.com/utopiafar/mote.
Use docs/agent-install.md and the deployment CLI. Inspect the environment and
existing installation, then create an isolated trial or use the instance I select.
Preserve existing data and credentials. Verify authenticated health and help me
save and open a generated note or a file I choose in Central. Continue with AI,
a collector or cross-device access when requested. Keep secrets out of output
and Git. Follow the authorization already given; ask when consequential scope
is unclear or changes. Report actual results and remaining gaps concisely.
```

Installation authorizes ordinary setup in the selected environment. Public network exposure, persistent services, archive reset and paid data processing need applicable authorization; do not ask again when already explicit. Existing archives and old formats are not disposable trial data.

## Local Central

Use Node 24 and npm 11. Actually run their version commands; a path alone does not prove its libraries load. macOS native dependency builds need Command Line Tools. [Deployment](deployment.md#native-environment-checks) covers Homebrew PATH/dyld failures and managed media dependencies.

Inspect an existing instance's checkout, profile/home, runtime, data location and status before starting another writer. Keep a healthy chosen installation; do not stop an occupied port's process or initialize over a profile. For a new source trial:

```sh
git clone https://github.com/utopiafar/mote.git
cd mote
npm ci
npm run build:central
node scripts/mote.mjs --help
node scripts/mote.mjs init --profile dev --home "$MOTE_INSTALL_HOME"
node scripts/mote.mjs start --profile dev --home "$MOTE_INSTALL_HOME"
node scripts/mote.mjs status --profile dev --home "$MOTE_INSTALL_HOME"
```

Set `MOTE_INSTALL_HOME` to the selected new absolute private directory first; every command uses the same home/profile. `init` refuses an existing profile, and `--port N` selects another free port. For Linux/NAS Docker use the [deployment path](deployment.md#linux--nas-docker).

New profiles have no model. Keep the archive-only trial unconfigured for AI; an existing profile's actual model/processing settings must be inspected before adding data. Model connection tests may themselves invoke a paid service. Do not copy keys or enable processing to make onboarding appear complete.

`start` waits for authenticated health. Confirm `healthy: true`, profile/runtime and the actual returned Central address. Open that loopback URL and sign in through the existing owner login. `token` intentionally displays a credential, so use it only for private local handoff, never in a committed file, command argument, issue or screenshot.

Save a generated note or selected file and open its original in Central. That readable record completes local onboarding; a PID, invitation or queued upload alone does not. Missing optional OCR/audio does not mean an accepted original was lost. Models and dependencies use the explicit [media setup](media-setup.md).

## Devices and remote access

A phone cannot reach another machine's localhost. Use an existing reachable HTTPS origin or the authorized [TLS/Tunnel setup](deployment.md); an invitation does not create connectivity. Persistent launchd/Docker management and network changes follow their actual authorization.

Use the matching app from [official releases](https://github.com/utopiafar/mote/releases); installing does not require building or publishing a new release. In Central open the device connection entry (`#/connections/pair`), create a private one-time invitation and confirm its destination on the client. [Mac](desktop.md), [Android](android.md) and [connections](connections.md) cover permissions and login.

Choose a source, reading range, existing-history inclusion, complete-file destination and retention. When capture was requested, verify local durable save, matched upload ACK and the same readable Central original separately. Respect current pauses and sending policy. OS permission prompts stay on the device.

## Handoff

Give the selected checkout, profile/home/runtime, actual address and health; data location and exact stop/status commands; saved-record read result; and concrete remaining model/network/device gaps. Do not include credentials. Unknown outcomes need inspection before retry, and an unavailable optional step does not block independent work.

Repository development uses [development](development.md) and [AGENTS.md](../AGENTS.md); this installation guide adds no contributor workflow.
