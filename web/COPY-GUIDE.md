# Copy guide — how this site talks

People do not read. They assume they know how it works, glance at the biggest thing on screen and click.
The site must be safe and usable for that person. Machines (and authors) read every word; users read almost none.
Write for the user.

## Rules

1. **One instruction per step, in the imperative, 12 words or fewer.** "Drop your Syntakt firmware file here."
   Everything else is secondary text (smaller, dimmer) or collapsed under "Details". If the step works without
   reading the secondary text, the step is right.
2. **The next action is always obvious.** Exactly one primary (red, filled) button per view. After every action,
   say what happened and what to do next: "Saw added to WAVE 120. Add more waves, or go back and build."
3. **Speak the instrument's language, not the firmware's.** Primary label: the value the user sees on the
   Syntakt ("WAVE 120"). Frame numbers, sections, offsets, checksums, SHA-256, "container", "registry" never appear
   in primary text. They live under "Details" for people who want them.
4. **Disabled things explain themselves where they are.** Not a greyed-out button with a rule written three
   paragraphs above, but "Load a firmware file first" on or right next to the button.
5. **Errors = what happened + what to do, in plain words.** Bad: "Container checksum mismatch." Good: "This file
   is damaged or is not a Syntakt firmware file. Download it again from elektron.se and try once more." Technical
   reason under "Details".
6. **Never blame, never scare without a reason, never joke.** Warnings only where the user can lose something.
7. **Say the irreversible thing at the moment it matters**, not only at the top of the page. The top safety box is
   read by nobody; repeat the one critical sentence next to the Download button.
8. **Short safety box.** Four bullets at most, each one line if possible, the single most important action in bold
   first: can you put the official firmware back? The long version goes under "Read more".
9. **Defaults must be safe and good.** A user who touches nothing but the required inputs gets a correct result:
   band limit 40, Replace, the shared sine locked.
10. **Show, do not describe.** A changed wave is red on the strip; a moved one is amber. Do not explain in prose what
    a colour and a legend already say.
11. **Numbers the user can act on.** "Keeps 40 harmonics. Lower this if the wave sounds harsh on high notes." not
    "1.50% of the energy discarded above the band limit" as the primary line (that goes to Details).
12. **Flashing instructions are a numbered list of physical actions**, one action per line, starting with a verb,
    including what the user should SEE ("The Syntakt restarts by itself. Do not switch it off before that.").
13. **Consistent words.** Pick one and keep it: "firmware file" (official), "your image" (built here),
    "wave" (not frame/table/slot in primary text), "Build", "Download", "Forget my files".
14. **Test of done:** cover all secondary text with your hand. Can a first-time user still complete the task
    without making a dangerous mistake? If not, the primary text or the defaults are wrong.

## Tone

Plain, calm, short sentences, British or American spelling but consistent, no exclamation marks, no emojis,
no marketing. Second person ("your file"). Present tense.
