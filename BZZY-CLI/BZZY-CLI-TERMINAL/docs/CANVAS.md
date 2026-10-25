# Character canvas

`bzzy --canvas` opens the canvas in an interactive terminal. Plain `bzzy` now
opens the three-section Codex-style transcript, while `bzzy --minimal` retains
the ultra-compact transcript and message input. JSON, detached execution and
noninteractive commands keep their existing behavior.

Right-click the workspace, or press **F10**, for New chat, Open chat and Settings.
A new chat is empty. Insert BZZY opens Core's model catalog with its supported
efforts. Saved solo defaults and explicit launch selections populate the initial
cast; workflow flags continue to use their existing setup and defaults.
Click the centered title to rename the chat. **Open session ▾** beside it lists
the other aliased terminals, newest saved activity first. Only named chats appear
in this catalog, and they reopen in their original directory without inference.

Each character is a saved model slot with its own provider/model/effort. All use
the same square pixel design and eyes, with a randomly assigned coat color that
stays stable when reopening or changing the model. Warp, Kitty, Ghostty and
iTerm2 3.6+ use PNGs; other terminals use filled Unicode half-block pixels from
the same design. Detection uses the terminal's environment metadata, so SSH
sessions that do not forward that information use the Unicode fallback.
Monochrome and small terminals remain supported. `--no-pet` disables motion.

The **model · effort ▾** line below each character has separate clickable model
and effort controls. Their dropdowns use Core's discovered catalog and supported
reasoning levels. Applying a change pauses work and leaves it paused; cancelling
does not change the selection. Linked groups must be paused and unlinked first.
Subscription models retain their existing login rather than requesting API keys.

The **Goal** row below the alias shows the selected character's objective, or
the group's control goal for a linked character. Double-click that row to edit
it in place, then press **Enter / Start goal** to submit through Core. Escape
cancels and preserves the conversation draft. An active or paused goal still
requires the existing replacement confirmation. An achieved Debate source stays
immutable: use its review action, or pause and unlink to set a different goal.

The canvas remains mounted throughout interaction. Context-menu goal entry,
renaming, private key entry and Settings open as canvas dialogs; double-clicked
goals edit in the header. Conversations open in a drawer,
beside the character on wide terminals or in a larger window on compact screens.
The close button and Esc return to the same canvas and preserve the draft.
Only explicitly opening a conversation enters its drawer; repeated ordinary
clicks on a character just select it. Private sharing/QR screens retain their
uncached rendering and full QR quiet zones.

- **Tab / arrows** select a character; **Enter** opens its conversation.
- **Click** selects; **Close × / Esc** closes the foreground window.
- **F10 / right-click** opens the selected character's actions.
- **Esc** closes a conversation and returns to its canvas; work continues.
- **Set goal**, **Pause work** and **Resume paused goal** use Core's existing
  durable goal and input admission operations. Chat remains available in the
  expanded conversation, including approvals, typed answers, sharing and skills.
- **Link to another BZZY** selects a target and Delegate, Debate, Besties or
  Parallel. The affected conversations pause and workers must stop before the
  link is applied. Linking does not resume work or change tool permissions.
- **Move character** places it with the next click. Positions persist and scale
  with the terminal. Tab changes pages when the entire cast cannot fit.

Delegate links are directed: the source is BRAIN and the target is HANDS. The
brain plans, delegates bounded assignments, reviews evidence and controls the
goal. Tall terminals show the brain above its hands. Debate's **Review achieved
goal + evidence** creates a separate review of the source's original objective,
achieved claim and complete evidence inventory; it does not overwrite that goal.
Parallel and Besties use the existing independent and collaborative Core engines.

Status comes from authenticated Core snapshots. Speech bubbles use recorded
model messages, assignments and peer exchanges. Curved link highlights occur
only for newly observed exchanges; loading old history does not animate past
work. Completion is Core's goal outcome, not an animation or a model's text claim.
Offline controls remain locked until Core responds again.

You can insert up to eight characters. A mode configured in another client can
also project its actual Core model slots into the canvas. Delegate groups contain two; the other
linked modes contain two or three. Groups cannot overlap or nest. Pause and
unlink before changing a linked model or moving it into another group. Unlinking
retains the conversations, budgets, evidence and worker history, and keeps work
paused. Removing a character preserves its records; deleting a named canvas
requires every companion and worker to be inactive.

Core stores composition under `terminal.canvas`. Independent characters have
separate unnamed terminal sessions in the canvas directory; assigned characters
show the actual worker thread produced by the mode engine. **Work history** opens
recorded threads without resuming them. These characters are not persistent Core
Agents. iPhone and Relay retain their existing terminal protocol and grants;
the canvas graph is a CLI presentation and does not widen phone/observer access.
Portable project sharing retains its existing history and evidence behavior;
canvas layout, private bindings and active graph connections are not transferred.

Native artwork uses the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/),
also supported by [Warp](https://docs.warp.dev/terminal/more-features/files-and-links),
[Ghostty](https://ghostty.org/docs/features) and recent [iTerm2](https://iterm2.com/documentation-images.html).
Images travel as bounded direct PNG chunks, with responses suppressed. No file
paths or terminal filesystem access are used. The compositor removes its own
placements before overlapping dialogs, private views and exit; it does not
delete another application's images. Tmux/screen and unknown terminals retain
the Unicode path. `BZZY_CANVAS_GRAPHICS=off` disables native graphics if needed.
