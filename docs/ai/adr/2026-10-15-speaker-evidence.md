# Speaker recognition and evidence

Status: accepted

## Context

Speaker recognition must filter speech before it reaches transcription or a voice attachment. Evidence in a submitted transcript arrives too late.

Sherpaw uses a cosine threshold of 0.35 with one-second windows. AIRI reuses this model and threshold for its audio filter.
The threshold has not been calibrated for the user's microphone, echo cancellation, noise suppression, or automatic gain.

`@proj-airi/core-agent` already carries speaker evidence. `updateSpeakerEvidence` accepts evidence for audio inside an input until its transcription ends, and the submission carries the newest evidence. Before this change, no code wrote evidence.

## Decision

### Speaker recognition setting

The Voiceprint settings page has a Speaker recognition switch. It is off by default, and it is available only with a usable voiceprint.

Continuous listening and captured recordings retain the shared tracker Worker. The last release terminates it.

### Audio filtering

`prepareOwnerSpeech` compares one-second windows before transcription or voice message encoding. Recording completion also checks its final partial window.
Before the first matching window, rejected audio stays local. After a match, rejected windows become silence with the same duration.
The transcription provider opens only after a match. An unmatched input is cancelled without a chat draft.
Automatic input and wake words check half-second owner voice windows before interrupting an existing response.
The rule applies even when ordinary Speaker recognition is off. Missing voiceprints or failed comparisons prevent automatic interruption.
Successful admission preserves the matching audio for transcription and does not wait for input completion.
CAM++ requires at least 250 ms. A shorter final tail borrows preceding samples for comparison, while its output keeps only the original tail.
A short utterance without enough preceding audio cannot establish speaker identity and is rejected without a model request.
The host pins interruption targets when capture starts. A new response invalidates a delayed match.
External wake adapters cannot bypass this check. Manual controls still explicitly interrupt playback.
Voice messages filter before the stream splits into transcription and WAV encoding. An unmatched recording creates no attachment.
Missing or changed voiceprints, model errors, and non-finite scores never release unchecked audio.
Changing the switch cancels active recordings. A deleted voiceprint does not silently disable filtering.

The microphone captures local audio for comparison. This filter does not separate simultaneous speakers or guarantee recognition of every voice.

### Comparison

`createSpeakerEvidencePlugin` compares 1 s of audio with the owner every 250 ms. These are the defaults of Sherpaw `similarity`. The owner is speaker 0 of the tracker, because the tracker enrolls only the saved voiceprint.

The plugin compares only windows inside the active input, as `acceptsEvidence` of the input decides. It uses `latest` scheduling, so a busy Worker skips windows instead of queuing audio.

Each comparison uses the window as mono PCM clamped to [-1, 1]. The tracker throws a `RangeError` for any other sample, and loud sound near the microphone can give samples slightly above 1. The wake word detector and the voiceprint enrollment use the same `toMonoSamples`.

A comparison counts when the VAD marked at least half of its audio as speech. Pauses then do not lower the score. The voice activity plugin reports each VAD window of an input through `onActivity`, which now carries the window range. A comparison waits until these VAD results reach its end. A window without an embedding gives NaN and does not count.

### Evidence

After each new counted comparison, the plugin writes this evidence to the input:

- One candidate, `owner`, with the mean cosine of the counted comparisons.
- `voicedMs`: the VAD speech between the start of the first counted comparison and the end of the last one.
- The range of the same audio.

### Prompt

The chat prompt does not include speaker evidence. `formatSpeechContext` leaves it out. The cosine has no calibrated threshold yet, and the model can read a low score as another person. The speaker gates decide what the model receives.

### IO trace

The `Voice input` span records the newest evidence that the plugin computed, even when the input rejected it:

- `speaker.score`: the mean cosine.
- `speaker.scores`: the cosine of each counted comparison, in time order. A gate that decides early can use the first values.
- `speaker.voiced_ms`: the speech behind the score.
- `speaker.rejected_count`: the updates that the input rejected, mostly because its transcription had ended.

### Failures

A failed comparison stops its filtered stream without exposing unchecked samples. The existing evidence observer also reports comparison failures.
Cancellation releases the recording's tracker reference. A comparison that completes after cancellation cannot publish its audio.
Each filter keeps its enrolled voiceprint identity. A changed or deleted voiceprint invalidates the active filter.

## Consequences

- The evidence plugin remains an observer. The separate PCM filter decides what reaches a provider.
- The filter covers automatic input, wake words, dictation, Push to Talk, and voice messages.
- Manual input still has no VAD-based evidence, but its captured audio passes through the same filter.
- Scores come from the processed microphone input, as does enrollment.
- Ordinary classification uses one-second windows. Automatic interruption uses half-second windows plus model execution time.
- Short final tails use preceding audio to satisfy the model's minimum window. Output contains each accepted sample once.
- Similar voices, microphone changes, short utterances, and overlapping speech can cause classification errors.

## Verification

Tests cover accepted speech, rejected speakers, non-finite scores, model errors, cancellation, and final partial windows.
Provider-boundary tests confirm that rejected speech starts no transcription request. Voice message tests check the filtered attachment and transcript.
Settings tests cover deletion while filtering remains on and explicit recovery through the switch.
Host tests keep a real playback group active through external wake detection, rejected voice windows, missing voiceprints, and delayed matches.
They confirm that a half-second owner match stops playback, including when ordinary Speaker recognition is off.
A smoke run used the real CAM++ Worker with the existing Samantha and alloy fixtures.
With Samantha enrolled, owner scores were 0.873–0.912 and alloy scores were −0.033–0.081. All alloy audio was rejected.
A separate half-second smoke check scored the enrolled fixture at 0.819 and the other fixture at 0.051, accepting only the enrolled voice.
These fixtures do not establish accuracy for the user's voice, microphone, or room.
