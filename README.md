<p align="center">
  <img src="docs/images/readme-header.webp" alt="dsh-media-gen — Images and videos, from chat" width="960" />
</p>

# dsh-media-gen

[English](README.md) | [日本語](README.ja.md)

An image and video generation plugin for DeepSeek Harness (DSH). It reuses the providers and credentials configured in DSH, so you do not need to register API keys twice.

- [Design policy](docs/policy.md) (Japanese)
- [Initial integration investigation](docs/investigation.md) (Japanese)

## Features

- **Images:** generates through OpenRouter's Image API (`/images/models`, `/images`). Real API generation has been verified on DSH `0.2.0-rc.2` on Windows.
- **Videos:** submits jobs through OpenRouter's Video API (`/videos/models`, `/videos`), watches them in the background, saves completed videos in the working directory, and notifies the session. Generation and saving have been verified on DSH `0.2.0-rc.2`.
- **Browser integration:** video previews, settings, chat model selectors, generation cards, and inline media displays. **Their appearance in a running DSH instance has not been verified.**
- Unit tests use mocked network requests.

### Languages

Approval dialogs, the plugin name, and browser UI support English and Japanese. They use Japanese when the DSH language is `ja`, and English otherwise. Tool descriptions and video completion notifications sent to the agent are English; the agent reads the notification and replies in the user's language. Command responses are currently English.

## Compatibility

See [CHANGELOG.md](CHANGELOG.md) for changes in each release.

| Plugin | Supported DSH |
|---|---|
| `v0.1.0` | `0.2.x` from `0.2.0-rc.2` onward (verified: `0.2.0-rc.2`) |

## Installation

Install a tag compatible with your DSH version. The repository includes the built `lib/` files; cloning, building locally, and pnpm build approvals (`allowBuilds`) are unnecessary.

```sh
dsh plugin --profile web add 'git+https://github.com/so16tm/dsh-media-gen.git#v0.1.0'
```

`web` is an example profile. Replace it with your profile name if different.

- This repository is private. Your local git must be authenticated with GitHub (for example, through Git Credential Manager on Windows).
- To update, run the same `add` command with the new release tag and restart DSH. The installed version is replaced; removal first is unnecessary.
- Without a tag, the command installs the latest `main`, including unreleased changes. DSH does not preserve the `#...` suffix in the profile's `package.json`; reinstalling without a tag therefore installs `main` even after a tagged installation. Use a tagged `add` command when you need a specific release.

To remove the plugin:

```sh
dsh plugin --profile web remove dsh-media-gen
```

### Provider setup

Add an OpenRouter provider in DSH's Models settings and save its API key. The plugin recognizes providers whose route name is `openrouter` or whose Base URL host is `openrouter.ai`.

## Usage

### Two ways to generate

| | Through the agent | Direct generation |
|---|---|---|
| Entry point | Ask in chat, or choose **Ask the agent** on a generation card | `/image`, `/video`, or **Generate as written** on a generation card |
| Prompt | The agent writes the prompt using your request and the model's prompt notes; it decides whether to translate or rewrite | Your text is sent unchanged |
| Confirmation | The approval dialog shows the actual prompt and estimated cost when approval is required | The card shows estimated cost. Commands return only an estimate without `--yes` when approval is required |
| Missing information | The agent asks with DSH question cards when it cannot infer details such as size or length | Unspecified options use model defaults |

#### Prompt notes

You can save free-form guidance for each model, such as “English only,” “natural language,” or “tag list.” OpenRouter does not provide this information, so notes are not bundled. Ask the agent to research and add notes for a model when needed. It saves them with `media_set_prompt_notes` and reads them alongside `media_list_models` results. Notes persist in DSH storage across restarts. Saving or clearing them always requires confirmation because agents in all future conversations can read them.

#### Generation cards

Open **Generate…** to the left of the chat input. Choose image or video, then content, model, aspect ratio, resolution, length, and audio. Available options come from the selected model's catalog entry.

If the conversation already has a chat-input model selection, selecting a different model on the card and choosing **Ask the agent** also changes that conversation's model. Agent tools prioritize the conversation's selection, so both card buttons use the card's model.

#### Direct commands

| Command | Behavior |
|---|---|
| `/image [--model id] [--aspect 1:1] [--resolution 1K] [--count n] [--seed n] [--image path]... [--yes] <prompt>` | Generates images and saves them in `generated-media/`. Repeat `--image` for multiple input images |
| `/video [--model id] [--duration seconds] [--aspect 16:9] [--resolution 720p] [--audio on\|off] [--seed n] [--first path] [--last path] [--ref path]... [--yes] <prompt>` | Submits a video job. `--first` and `--last` supply the first and last frames; repeat `--ref` for reference images |
| `/media-jobs [job-id]` | Lists video jobs for this session. With an ID, checks its status immediately |

Place options before the prompt. Quote paths containing spaces with `"`. With `requireApproval` enabled and no conversation-wide permission, add `--yes` to generate; otherwise the command returns an estimate only.

A job started with `/video` does not trigger an agent turn when it finishes. Its notification reaches the agent on the next turn; use `/media-jobs` for an immediate check.

### Tools

| Tool | Behavior |
|---|---|
| `media_list_models` | Lists image models of configured providers (video models with `kind: "video"`) and accepted parameters |
| `media_generate_image` | Generates images, saves them in `generated-media/` under the working directory, and displays attachments |
| `media_generate_video` | Submits a video job and immediately returns its ID; saves the completed video in `generated-media/` and notifies the session |
| `media_video_status` | Lists video jobs; with `job_id`, checks the provider immediately |
| `media_get_prompt_notes` | Reads saved prompt notes |
| `media_set_prompt_notes` | Saves a model's prompt notes; empty notes clear them |

### Session model selection

Use `/media-model` to choose the image or video model for a session. When a tool call omits the model, it uses the session selection, then the configured default. A session selection also overrides a different model explicitly requested by the agent.

| Command | Behavior |
|---|---|
| `/media-model` | Shows current selections and defaults |
| `/media-model image` | Lists available image model IDs; use `video` for video models |
| `/media-model image <model-id> [provider]` | Selects this session's image model; unlisted IDs are rejected |
| `/media-model image default` | Clears the session selection and restores the configured default |

Use `video` in place of `image` for video selections. Selections are stored by session ID in DSH storage and survive restarts. The **Image** and **Video** selectors beside the chat input use the same operation.

### Browser integration

DSH loads `lib/client.js` to add these interfaces:

- **Video previews:** plays mp4, m4v, webm, and mov in DSH's file preview, up to the 32 MiB size DSH can load in full.
- **Settings:** selects default image/video models from provider catalogs and changes image-count and duration limits, approval, and notifications.
- **Chat selectors and generation cards:** as described above.
- **Inline media:** replaces the generic DSH tool cards only for `media_generate_image`, `media_generate_video`, `/image`, and `/video` result rows. Images open in the file preview. Images generated by the agent also appear as thumbnails below its reply with the same action buttons. **Use for image** opens a generation card using the image as input; **Use for video** uses it as the first frame. Only models supporting input images appear on these cards. **Use in chat** puts the image path into the chat input, replacing its draft. Video rows check job status until completion and allow playback once the video has been saved.

Catalogs, session selections, and estimates are read through authenticated Host routes `api/media-gen.models`, `api/media-gen.session`, and `api/media-gen.estimate`. Media is read through `api/media-gen.file` (with `Range` support); job status uses `api/media-gen.job`. API keys are never sent to the browser.

The file route serves recorded plugin outputs and, for images saved before file tracking existed, images directly under folders matching the configured `outputDir` (default: `generated-media`). This fallback does not distinguish working directories. A resolved link must also be directly under a folder matching that output directory, and its content must be PNG, JPEG, WebP, or GIF. **Do not use a common folder name such as `Pictures` for `outputDir`.**

### Video jobs

- Jobs are recorded in DSH's storage domain, and unfinished jobs resume watching after a restart. Without storage, jobs remain only in memory and cannot be tracked after restarting.
- Status is checked every `videoPollIntervalMs`. Completed videos are downloaded immediately because OpenRouter does not publish its retention period.
- Completion, failure, and expiry are reported to the originating session. If the session is closed, notification is delivered when it next opens.
- Jobs still unfinished after `videoMaxWatchMs` stop being watched and show “stopped.” OpenRouter has no cancellation API: this does not cancel the provider job. Pass `job_id` to `media_video_status` to resume checking.
- If duration is omitted and the model offers durations above `maxVideoSeconds`, the plugin sends the longest available duration within the limit. If the model does not list supported durations, the plugin cannot apply this limit to its default duration.

### Approval, input images, and costs

DSH's approval dialog offers only denial or one-time permission. To allow generation for a whole conversation, use **Ask before generating** in the chat input's **Media** menu or `/media-approval on`. In an allowed conversation, agent generation and `/image` or `/video` without `--yes` can run without per-generation confirmation. `/media-approval off` restores per-generation confirmation. Only the user can change this permission; agents cannot.

`requireApproval` controls the normal per-generation confirmation. The following agent-tool exceptions still require confirmation even when it is disabled or the conversation is allowed:

- Sending input images outside the working directory. Their paths appear in the approval dialog.
- A second or subsequent generation call in the same agent turn, to prevent the agent from deciding to regenerate on its own.

Direct commands use `requireApproval`, `--yes`, and conversation permission for their confirmation decision; the two agent-tool exceptions above do not apply to direct commands.

For input images, agents pass paths in `media_generate_image.input_images` or `media_generate_video.first_frame`, `last_frame`, and `reference_images`. Files are read before submission and sent as Base64 data URLs. Only PNG, JPEG, WebP, or GIF files up to 20 MiB are accepted. Models whose catalog does not support the requested input image or frame are rejected before submission. Per-input-image charges, when listed by the model, are added to the estimate.

`media_generate_image` takes `prompts`, one prompt per image, and generates one image per prompt. “Three different poses” should be one call containing three prompts, with one confirmation. When requesting multiple images, a prompt that describes several different images is rejected before billing, to avoid putting all of them in a single image. `/image --count` repeats the same prompt instead.

Generation results tell the agent that images are already visible and ask it not to open and reread them or ask again whether to generate. Follow-up work such as “make an image, then animate it” can continue in the same request; the second generation requires confirmation. If a later image fails, already saved images are returned with the failure. After a timeout or unusable response, the agent is instructed not to retry on its own because the provider may already have charged for the request.

Approval dialogs estimate cost from the catalog's `pricing_skus`. Per-second prices are multiplied by duration; uncertain resolution or duration produces a range. Unrecognized pricing is shown as unknown. When a required agent approval cannot be priced because catalog retrieval or another estimate step failed, the dialog states that failure and still asks. Estimates are based on output pricing and may understate the actual bill when a model also charges for input images or tokens.

Approval runs at the outermost `tools/pre-execute` handler. A DSH `tools.guard` blocks agent generation allowed by another mechanism that bypassed this handler.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `defaultImageProvider` | unset | Default DSH provider ID for images |
| `defaultImageModel` | unset | Default image model ID |
| `maxImagesPerCall` | 4 | Maximum images per call |
| `defaultVideoProvider` | unset | Default DSH provider ID for videos |
| `defaultVideoModel` | unset | Default video model ID |
| `maxVideoSeconds` | 10 | Maximum video duration per call, subject to model catalog limits described above |
| `requireApproval` | true | Asks before generation unless the conversation is allowed; agent repeat-generation and outside-image checks still apply |
| `outputDir` | `generated-media` | Output path relative to the working directory; must stay inside it |
| `catalogTtlMs` | 600000 | Model catalog cache lifetime |
| `requestTimeoutMs` | 180000 | Provider request timeout |
| `maxImageBytes` | 31457280 | Maximum accepted generated-image size |
| `videoPollIntervalMs` | 30000 | Video job polling interval |
| `videoMaxWatchMs` | 10800000 | Maximum watching time (3 hours) |
| `maxVideoBytes` | 524288000 | Maximum accepted generated-video size |
| `notifyOnVideoCompletion` | true | Notifies the session when a video job ends |
| `chatImageModels` | unset | Image model IDs shown in the chat menu; empty means all catalog models |
| `chatVideoModels` | unset | Video model IDs shown in the chat menu; empty means all catalog models |

Open DSH's Plugins page, select **Media Generation**, and open **Media Generation >** from its Components row. Models shown in chat are chosen through a searchable checklist. Even with a selection, **All models…** in the chat menu can select another model. The agent's `media_list_models` always returns all models, regardless of this filter.

## Limitations

- Browser UI appearance has not been verified in a running DSH instance; unit tests use mock network requests.
- Cost estimates are approximate and may omit some input-image or token charges.
- Browser video preview is limited to 32 MiB, independently of the larger `maxVideoBytes` download limit.
- Avoid common `outputDir` names: the legacy-image route does not distinguish working directories. See Browser integration above.
- Stopping video tracking does not cancel or refund the provider job. Without DSH storage, tracking does not survive a restart.
- Mandatory outside-image and same-turn regeneration confirmations apply to agent tools. Direct-command confirmation follows `requireApproval`, `--yes`, and conversation permission.

## Development

After cloning the repository:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs type checks, the build, unit tests, and validation of the current version's CHANGELOG section. To try the local checkout:

```sh
dsh plugin --profile web add <absolute-path-to-clone>
```

After editing `src/`, rebuild with `pnpm build` and commit the generated `lib/` files with the source changes.

DSH peer dependencies require `>=0.2.0-rc.2 <0.3.0`. Development and type checks use the published `0.2.0-rc.2` packages.

### Releases

Versions are managed through `package.json.version` and tags named `v<version>`.

1. In a PR, bump `version`, add a `## v<version>` section to [CHANGELOG.md](CHANGELOG.md) with supported DSH versions and changes, and update the compatibility tables in both README.md and README.ja.md. `pnpm check` fails without the matching CHANGELOG section.
2. After the PR is merged into `main`, CI automatically creates the version tag and GitHub release.

Do not create, move, or delete tags manually. Keep earlier releases supporting older DSH versions in the compatibility tables. CI runs `pnpm check` for PRs and pushes to `main`, and checks that committed `lib/` files match the build output.

Use a minor version for new DSH support or added/changed features (`0.1.0` → `0.2.0`) and a patch version for bug fixes (`0.1.0` → `0.1.1`).

## License

MIT, as declared in [package.json](package.json).
