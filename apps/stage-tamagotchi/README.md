# Stage Tamagotchi

The Electron desktop app runs AIRI characters, chat, voice, and desktop tools.
Shared character behavior belongs in `packages/stage-ui`. Use `stage-web` for browser-only features.

## Development

From the repository root, run `pnpm install`, then `pnpm dev:tamagotchi`.
Run `pnpm -F @proj-airi/stage-tamagotchi build` to build the app.

## Local companion profile

Set `APP_USER_DATA_PATH` to keep the companion profile separate from other AIRI installations.
The [fork README](../../README.md#fork-development-log) owns the development record. Its [configuration section](../../README.md#fork-configuration) records the active interfaces and settings.
Companion defaults apply only on first setup. Later starts preserve saved reasoning and sampling preferences.
For MiniMax-M3.1-Flash, Thinking off selects `reasoning_effort=low`. This model does not support disabling thinking completely.
On Linux, move the character with the four-arrow handle. Canvas dragging also works where global pointer coordinates are reliable.
A click triggers the model's matching tap motion.

On Wayland desktops, including XWayland, the stage and visible chat panels keep their full window area interactive.
Transparent pixels still show the desktop, but do not pass clicks to applications below the window. Auto Hide stays off.
Hidden voice layers and folded chat panels still pass clicks through. Native X11 sessions retain pointer-based transparency hit testing.

The configured MiniMax providers use these official interfaces:

| Role | Model | Base URL |
| --- | --- | --- |
| Chat | `MiniMax-M3.1-Flash` | `https://api.minimax.cn/v1/` |
| Hearing | `asr-1.0` | `https://api.minimax.cn/v1/` |
| Speech | `speech-2.8-turbo` | `https://api.minimax.cn` |

The Hearing provider is **MiniMax ASR** (`minimax-audio-transcription`). It sends audio files to `/v1/speech_to_text`.
Desktop MiniMax Speech uses `/ws/v1/t2a_v2_bidi` with the voice selected in **Settings → Modules → Speech**.
Each speech stream opens one connection. Text reaches MiniMax as the chat stream produces it, and MiniMax determines sentence boundaries.
The existing player receives mono PCM at 32 kHz as audio arrives, before the reply text ends.
Text EOF sends `task_finish`, which synthesizes the final unpunctuated text before `task_finished` closes the session.
Owner interruption, manual Stop, and renderer loss close the connection and discard later audio.
The main process reads the saved key from encrypted provider storage and uses an Authorization header.
It accepts only official MiniMax endpoints. Neither the key nor an arbitrary endpoint travels through speech IPC.
Provider refusals, including queue-full code `2205`, fail the speech stream explicitly. They never report a truncated reply as successful.
The web and pocket clients retain HTTP speech. Desktop voice previews also retain the existing HTTP path.
After an update to this transport, restart the desktop main process. A renderer refresh alone does not install its IPC handlers.
Use the same MiniMax API key for these providers. Chat keeps the user's existing official MiniMax configuration.

Microphone capture starts only when the user enables it. The companion starts with capture, vision, and desktop control off.
AIRI's existing VAD splits speech, Hearing transcribes it, and the chat pipeline generates and speaks the reply.
Detection continues during playback. New speech can stop the current reply and its queued audio.
This uses separate ASR, chat, and TTS interfaces. It does not use the older `/ws/v1/realtime` endpoint.
Interruption records carry response IDs, cause, and playback progress. Full conversation snapshots and images do not enter later control prompts.
Voice requests project saved records to these fields without changing chat history or local memory.
See the official [ASR guide](https://platform.minimax.cn/docs/guides/speech-to-text),
[bidirectional speech reference](https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket-bidi), and
[system voices](https://platform.minimax.cn/docs/faq/system-voice-id).

Desktop provider settings use Electron `safeStorage` and the system keyring.
The first load migrates the two credential-bearing localStorage entries after the encrypted write succeeds.
The elected Pinia leader owns later writes. A locked or unavailable keyring produces a visible error.

### Voiceprint filtering

Open **Settings → Hearing → Voiceprint**, enroll your voice, and enable **Speaker recognition**.
Recognition checks audio locally before transcription or voice message encoding.
Automatic interruptions check half-second owner voice windows, even when ordinary speaker filtering is off.
Missing voiceprints or model failures prevent automatic interruption. Stop and Push to Talk remain explicit manual controls.
A matching short utterance can interrupt without waiting for input completion. Audio below the model's 250 ms minimum cannot establish identity.
A late match can interrupt only responses present when that input began. External wake detectors cannot bypass this rule.
Replies that start during verification stay active, and the verified input continues to transcription and submission.
Stage opens an interruptible response only after the user message persists. Memory preparation cannot expose an uncommitted input to interruption.
An unmatched recording starts no transcription request and creates no chat draft.
Missing voiceprints and model failures block speech. The switch remains available to turn filtering off after voiceprint deletion.
Ordinary transcription uses one-second windows. A short final tail borrows preceding samples for comparison without duplicating output audio.
Similar voices and overlapping speech can cause recognition errors. The threshold has not been calibrated for the user's microphone.

### Screen vision

Enable **Vision** and select its provider and model in the module settings.
Open **Settings → System → Developer → Vision Capture**, then **Open screen observation**.
Observation runs in a separate window. Settings navigation does not stop it. Keep the observation window open or minimized.
On Linux PipeWire, the system picker returns one source. A whole desktop can appear under **Applications**.
Without startup restoration, select that source in the observation window. Starting capture uses it without requesting another catalog.

Enable **Publish to character** when the chat must receive the visual observations. Then select **Start ticker**.
The page shows startup progress until a decoded video frame arrives. An error stays beside the controls.
**Context updates** confirms publication. A preview alone does not mean the chat received an observation.

**Open screen observation at startup** is off by default. Enabling Vision alone never grants screen access.
With this option on, application startup opens the observation window and its source selection flow.
The application saves publication, workload, downscale, and interval choices. It never saves source IDs or system permissions.
When the system picker returns one selected native session, startup restoration resumes it without another source click.
Chromium marks that session with `:s`. Ordinary catalogs and multiple entries still require a source click.
On PipeWire, the system picker opens again. On macOS, missing Screen Recording permission opens the permission instructions.
This is a startup selection flow, not silent screen access. Cancelling permission or source selection leaves observation stopped.

**Stop ticker**, **Cancel capture**, a source change, disabling Vision, or closing the observation window ends capture.
A cancelled request can still finish in Electron. The application closes its late stream and discards later inference publication.
Stop does not clear the startup preference, and no settings watcher restarts it in the current window.
Restart the desktop main process after this update to install the observation-window IPC handler.
For a device check, enable the startup option, restart, grant permission, and select a source.
Confirm **Context updates** increases, navigate other settings pages, then check Stop and Vision disable each end sharing.


### Long-term memory

**Settings → Local companion** controls local conversation archives and SAG2 retrieval.
Each character has a separate archive under `<userData>/companion/memories`.
The page can list, edit, delete, export, and clear that character's records.
Clearing a character's memories also starts a new conversation for that character. Old chats stay archived, outside the new context.
The operation preserves character cards, provider credentials, model selections, voices, and voiceprints. Deleting one document remains a single-document operation.
Changing a card does not erase memory. Use **Clear memories and start a new conversation** when old dialogue must stop influencing the new setting.
The saved card name and nickname define its current identity. Application and tool labels do not rename the character.
Records contain original user text, final character replies, timestamps, and source identities. Provider reasoning is excluded.

SAG2 uses [OpenCode's `jev-1.13-free`](https://opencode.ai/docs/console/models/#jev)
at `https://opencode.ai/inference/systemone/v1/systemone`.
This exact free endpoint accepts anonymous requests in the verified configuration. Other endpoints still require credentials.
OpenCode lists this model as a limited-time free service.

Recall includes each cited turn's date and speaker labels, with a total limit of 12,000 characters.
SAG returns candidate evidence. An unrelated query can still return nearby records, so the character must use only relevant facts.
API and retrieval failures remain visible. They do not stop the character renderer or discard the local archive.
Idle time does not submit chat or recall requests.

Run the real SAG lifecycle and evidence checks with `AIRI_SAG_BINARY` set:

```sh
AIRI_SAG_BINARY="$HOME/.local/bin/sag" pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/sag-memory.test.ts
```


## Local model files

Sherpaw downloads remote model files into the app user data directory. The main
process serves installed files to the renderer through `airi-model`. The desktop
release bundles X-ASR through `airi-sherpaw`. Sherpaw settings control
remote downloads. The Resource Status Island shows transfer progress and errors.

## Computer use

The desktop chat composer starts with **Use computer** off. Turn it on only for requests that need desktop access.
The selection is shared across desktop windows. While a request runs, its selection is locked.

Only the current selection grants access, including retries and tool reruns. Historical messages do not grant access.
The selected request receives `computer_use` and `computer_use_read_image`.
The first tool accepts AUV arguments, such as `["invoke", "window.list"]`.
Use `["invoke", "--help"]` and command-specific help to discover supported operations.
The image tool returns a screenshot as model image content. It accepts PNG, JPEG, and WebP artifacts inside the app's computer-use store.
WebP artifacts convert to PNG. PNG and JPEG artifacts keep their original bytes.
Use a model and provider that support tool calls for visual tasks.
With **Use the vision model for tool images** on, the vision model reads the screenshot first for a chat model whose provider does not report image input.
The chat model then gets a text description. It has the visible text and layout, but no pixel positions.
Use AUV commands such as `screen.findText` to get coordinates.

Electron starts the matching AUV SDK and CLI 0.0.16 on demand, over a private Unix socket or Windows named pipe.
It serializes commands across windows, stores artifacts under the app's user-data directory, and stops the daemon during app shutdown.
The CLI runs without a shell. Model arguments cannot change the device, endpoint, run, or storage root.
Nonzero exits retain AUV output and failure details as tool errors. A zero exit code does not prove that the intended UI change occurred.

On macOS, grant Accessibility and Screen Recording permissions to the launching app when the OS requests them.
Some application actions also need Automation permission. If `app.probePermissions` reports missing screen-recording permission, a capture can contain only the desktop background despite exit code zero. Available commands depend on the OS and AUV backend.
Use this feature for local native applications. It does not expose a remote-device gateway or replace the separate `services/computer-use-mcp` service.

The desktop package includes the platform CLI as an optional dependency and unpacks its executable from ASAR.
Do not omit optional dependencies when building an installer. Windows ARM64 and Linux musl do not have a matching CLI in this version.

## Fullscreen workspace

The fullscreen workspace is an experiment, and it is off by default. It shows settings and the chat beside the character, in a workspace that covers the work area.
Turn on **Fullscreen workspace** in the experimental features of the system settings. Then choose a window mode:

- **Single window**: the main window grows over the work area and becomes the workspace.
- **Separate window**: a window of its own shows the workspace with its own view of the character. The main window stays on the desktop, above that window.

The two modes differ only in the window that hosts the workspace. Both use the same parts in `src/renderer`:

- `components/fullscreen/surfaces.ts` is the registry of the surfaces, such as settings and the chat.
- `stores/fullscreen.ts` holds the phase of the mode, the surface that shows, and the surfaces that stay mounted.
- `composables/use-fullscreen-layout.ts` holds the surface width, its drag, and the place of the character.
- `components/fullscreen/fullscreen-overlay.vue` shows the island and the surface. `fullscreen-backdrop.vue` shows the backdrop.

Each host adds only what its window needs:

- `pages/index.vue` is the page of the main window. It runs the open and close transitions, because the main window moves and grows.
- `pages/workspace.vue` is the page of the separate window. The window covers the work area from the start.
- In `src/main`, `windows/main` and `windows/workspace` answer the same fullscreen events for their windows.
- `src/main/index.ts` opens settings and the fullscreen chat where the mode says.

To add a surface, add an entry to `fullscreenSurfaces`, and add its id to `FullscreenSurfaceId` in `src/shared/eventa`.
The island then shows its button, and its panel stays mounted until the mode closes. The routes under its `prefixes` sit under the page of each host.

When the user changes the window mode, `moveFullscreen` in `src/main/windows/shared/fullscreen.ts` moves the workspace.
It packs the surfaces of the old window, closes that window through its pages, and opens the pack in the new window.
A page with unsaved changes can stop the move. A panel that holds state calls `useFullscreenCarry(surface, { collect, restore })`.
The chat carries its unsent draft this way, and settings carry the page that shows.

The view of the character in the separate window is a second render. It only renders the model, so the main window stays the one host of voice.
It does not follow speech or expressions.

## Dependencies

The main process bundles every package in `devDependencies`. The renderer bundles all packages.
electron-builder copies only `dependencies` and `optionalDependencies` into `app.asar`.

- Add a pure JS package to `devDependencies`, also when the main process imports it at runtime.
- Add a package to `dependencies` only when it loads a `.node` file or another binary file at runtime.

A package in `dependencies` stays external in the main bundle. electron-builder then copies it and its dependency tree into `app.asar`.

## Verification

Run the focused runtime tests:

```sh
pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/main/services/airi/computer-use/runtime.test.ts
```

Run the tests of the fullscreen workspace:

```sh
pnpm -F @proj-airi/stage-tamagotchi exec vitest run src/renderer/stores/fullscreen.test.ts src/renderer/window-context.test.ts src/main/windows/chat/mode-switch.test.ts src/main/windows/shared/fullscreen.test.ts
```

Set `AIRI_COMPUTER_USE_LIVE=1` to include the bundled CLI/private-daemon test.
It invokes help and an invalid argument, without injecting desktop input.
For renderer verification, launch with `APP_REMOTE_DEBUG=true` and an unused `APP_REMOTE_DEBUG_PORT`, then attach `agent-browser` to the chat CDP target.
