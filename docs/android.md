# Android

The Android application packages the existing face with Capacitor 8.6.2
(`dev.jarvis.app`, origin `https://jarvis.app`). Compilation runs in GitHub
Actions with Node 24, JDK 21 and Android SDK 36. This PC needs none of the Android
toolchain. The generated `android/` project and Gradle wrapper belong in Git;
copied web assets, builds and signing material do not.

## Fork and first build

The personal fork is https://github.com/saias-o/jarvis. In this checkout,
`origin` points at that fork and `upstream` keeps the original project.
The local modifications have to be committed and pushed before Actions can
build them. Creating the fork by itself does not upload those modifications.

After approval to commit and push:

1. Push the implementation to a branch in the personal fork. If Actions is
   disabled on the new fork, enable it in the repository's Actions tab.
2. Open **Actions → Android APK**, select the branch and run the workflow (pushes
   to `main`, `master` and `codex/**` also trigger it).
3. Download the `jarvis-android-<number>` artifact from the successful run and
   extract `app-release.apk`.
4. Transfer the APK to Android and allow installation from the app used to open
   it. Later APKs signed with the same key install as updates.

Tags named `android-v*` build and publish a GitHub Release containing the APK.
Pull requests compile a debug APK without access to the release signing secrets.

## Persistent signature

`node scripts/android-signing.mjs --github --repo=OWNER/REPO` generates the key
once with OpenSSL and sends four repository secrets through GitHub CLI's stdin:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

On Windows it uses the OpenSSL bundled with Git. On other machines OpenSSL must
be on PATH; `JARVIS_OPENSSL` can override its path. This is a setup-script option,
not an application setting.

The private backup is `.android-signing/`, excluded from Git. Back up that whole
folder privately. Never add it to a commit or a release. Keep the key: replacing
it prevents updates to an already installed app. The workflow restores it only
for the signing step and removes the temporary file afterward. It fails clearly
when signing secrets are missing rather than issuing a new key.

## Phone setup

1. Open **Réglages Android**.
2. Select **Automatique**, **PC distant**, or **Gemma sur le téléphone**.
3. For the local brain, download the generic
   `gemma-4-E2B-it.litertlm` (~2.6 GB) from the
   [LiteRT community repository](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm),
   or import an existing `.litertlm` file using Android's document picker.
   The download requires unmetered Wi-Fi by default, reports progress and can
   resume after a disconnection. Allow at least 3 GB free for the download;
   model execution also needs several GB of RAM. Check performance on the
   intended phone before relying on it.
4. Grant the microphone permission when using the Talk button. Install a French
   voice and an Android speech recognition service if the phone lacks them.
   Recognition prefers the on-device service when Android provides it; otherwise
   the system recognizer may use its provider's network service. There is no
   background wake word. Tap Talk to start or interrupt.
5. Grant shared-storage access in the Android system screen to let JARVIS list,
   read, write, move and open files. `Android/data`, `Android/obb` and credential
   locations remain refused. Text reads are limited and paged. Memory stays in
   the app's private `memory.md`. Writes are enabled for the phone tools.
6. The clip imports small attachments (up to 16 MB) into the phone's private
   inbox. For larger files use Android's **Share → JARVIS** (up to 1 GB).
   Attachments stay on the phone until the agent uses `upload_to_pc` for a
   requested transfer. This reuses the native streaming upload, keeps the phone
   original, and returns the path of the received file on the PC.
   Requested text excerpts and tool results are sent to the model as context.

All three brain modes use the same Android agent and phone tools. In PC mode,
the app calls `/inference` over Tailscale; the PC uses its Claude login to return
the next message or proposed phone tool calls. Android executes those calls and
sends the results back for the next inference step. The inference session itself
has no desktop tools, MCP servers or account connectors. The app also discovers
the PC's file tools through authenticated `GET /pc-tools`, exposes them to the
LLM as `pc_*`, and dispatches their calls through `POST /pc-tools`. These reuse
the existing PC file tools and obey its write setting, allowed roots and
credential restrictions. With writes enabled, `pc_run_command` also reuses the
PC command executor, with the same user-account access as the full desktop
agent's shell. This preserves general OS capabilities such as screen capture,
instead of limiting Android callers to files. The existing `show` tool accepts
an image path and opens the existing image viewer through the PC media bridge.
The LLM can inspect both devices, upload a phone file,
move the received PC file to the requested folder and verify it, within the same
loop. The desktop UI keeps its existing Windows agent. Update both the PC server
and APK together.

The inference adapter forwards client action proposals whether the model emits
them in structured output or as native `tool_use` blocks; these are dispatched
by Android, never executed inside the inference session. The existing Android
conversation history retains completed tool calls and results as well as the
spoken exchanges, so follow-up requests keep returned paths and action outcomes.
The bridge also supplies the PC's shared Windows known-folder locations to
inference, so localized names such as Images resolve to the real Pictures folder
even when Windows has redirected it into OneDrive.

`Download`, `Documents` and `DCIM` refer to the phone's shared storage. The
`list_files` tool supports a `documents` filter and pagination. File permission
state and the actual installed capabilities are included in the Android prompt.
Contacts, SMS, notifications and other apps' private data are not implemented.
Automatic mode falls back to Gemma when the PC is unavailable; completed tool
results stay in the same agent loop so file actions are not replayed.

GPU initialization falls back to CPU if it fails. The model is unloaded after
two minutes in the background and loaded again when needed. Download and import
are foreground operations; a foreground service is not implemented yet.

## Reaching a PC

Install Tailscale on both devices and connect them to the same account. Run
`npm run remote:writes` on the PC. In its `.env.local`, add:

```dotenv
JARVIS_REMOTE_ORIGINS=https://jarvis.app
JARVIS_REMOTE_CODE=off
```

The existing remote setup supplies `JARVIS_REMOTE_USERS` with the owner's
Tailscale account. A configured app origin alone never authenticates a request.
HTTP, preflight and WebSocket requests from the APK require that identity.
The PC bridge remains on loopback behind `tailscale serve`.

Enter the PC's `https://<pc>.<tailnet>.ts.net` address in the Android settings,
one address per line, and save. Only HTTPS Tailscale names without ports or
embedded credentials are accepted. The automatic mode probes health before
dispatching a question; it never replays a question after tools may have run.

The app normally connects without an access code: the Tailscale account is
the identity. Pairing controls stay hidden unless the selected PC explicitly
reports that its optional extra access code is required. A session
token authorizes HTTP requests and the WebSocket handshake without relying on
a cross-site cookie. Normal browser access keeps its original secure cookie.
The session token is kept in WebView session storage, so pairing may be needed
after the app is closed. With code enabled, authenticated media embedded with
`img` or `iframe` still needs additional support in the native app; use the
code-free, Tailscale-only setup above for full remote media.

## Validation

Local checks: `npm test`, `npx tsc -b`, `npx vite build`, `npx oxlint`,
`npx cap sync android`. Tests simulate Ollama and the Tailscale proxy; none
downloads a model or opens a Claude session.

Still required on GitHub and a real phone:

- Gradle compiles all plugins against the pinned LiteRT-LM 0.19.1 dependency.
- The signed APK installs and updates over a previous APK without data loss.
- The interface opens before a model is present; settings and typed input work.
- Local text streams and manual tool results produce a final answer.
- Talk, French recognition, French TTS and immediate interruption work.
- Download pause/resume, importing a model, shared files and file permissions work.
- Automatic selection works with the PC online, offline and behind an access code.
- Existing phone-browser access to the PC continues to work.

The mesh between nodes (phase B) remains a separate, pending implementation,
after the Android build and device checks in phase A.
