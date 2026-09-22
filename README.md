# Syntakt Firmware Workbench

An unofficial, browser-based workbench for owners of the Elektron Syntakt. You load the official
OS 1.41 file that you downloaded from Elektron, make your changes in a tool, and the page builds a
new file for you to flash yourself. Everything happens in your browser tab. Nothing is uploaded, and
the site cannot talk to your instrument.

Not affiliated with, endorsed by or supported by Elektron. Syntakt and Elektron are trademarks of
their owner.

## Read this first

- **Make sure you can put the official firmware back before you flash anything.** Try the restore
  procedure from the Syntakt manual once, with the official file, before you need it.
- Flashing modified firmware can leave your instrument unusable, and it voids your warranty.
  You do this entirely at your own risk.
- Back up your projects and sounds with Elektron Transfer first.

## What is available

**SY CHORD Wave Bank** - put your own single-cycle waves into the SY CHORD machine. You pick them
with its WAVE knob, as before.

- 31 waves can be changed (WAVE 4, 8, 12 ... 124); the values in between morph from one wave to the next.
- Takes single-cycle WAV files of any length, 8 to 32 bit, mono or stereo (left channel is used).
- The tool resizes each wave to one cycle, centres it, sets it to full level, lines it up to start at
  zero and limits its brightness (40 harmonics by default, adjustable for each wave).
- Replace one wave, or insert a wave so that the waves above it move up one step.
- The small wave picture on the Syntakt screen is redrawn to match your waves (checked on an
  instrument on 22 September 2026). You can switch it off in the tool's Settings; then only the
  sound changes.

### How it was checked

Files built with this tool were flashed onto a Syntakt running OS 1.41 and measured from the
instrument's own audio output (September 2026):

- a saw and a square wave came out within 1% of the waves that went in, over 40 harmonics;
- every WAVE value that was left alone measured exactly as it did before;
- adding a second change to a file that had already been changed was tested the same way;
- the screen pictures were checked by eye on the same unit: a square, a triangle, a saw and a pulse
  showed up as those shapes, and untouched WAVE values kept their original pictures.

Before it offers a download, the page checks that the new file differs from the official one only in
the parts that hold the SY CHORD waves and their pictures.

### Known limits

- **OS 1.41 only.** Any other file is refused rather than changed blindly.
- WAVE 0 is a sine that other machines also use. It is locked by default; if you unlock and change
  it, those machines change too.
- SY CHORD keeps one copy of each wave for all notes, so very bright waves sound harsh on high notes.
- Patterns and sounds that use a WAVE value you changed, or one next to it, will sound different.
  Flash the official file to get everything back.

## Technical notes

| | |
| --- | --- |
| Slots | 31 waves: WAVE 4, 8, 12 ... 124. The machine interpolates the values in between. WAVE 0 is a sine shared with other machines and is locked unless you allow it. |
| Slot format | 257 samples, big-endian signed Q31: one cycle in 256 points plus a guard sample equal to the first. The cycle starts at a rising zero crossing, carries no DC, and is scaled to full level. |
| Accepted input | One single-cycle WAV of any length: PCM 8, 16, 24 or 32 bit, IEEE float 32 or 64 bit, `WAVE_FORMAT_EXTENSIBLE`, mono or stereo. Only the first channel is read. |
| Done to each input | DFT to the band limit (8 to 127 harmonics, 40 by default, kept per wave), resynthesised at 256 points, phase-aligned to a rising zero crossing, DC removed, scaled to full level. Always derived from the WAV samples, never from an earlier result. |
| Part of the firmware that changes | The SY CHORD wave tables in the part that holds sound data and, when the screen pictures are switched on, the 128 small wave pictures the screen draws for the WAVE knob, plus three 4-byte pointers that say which picture three of the WAVE values use. No program instructions, no other machine. Waves you do not touch are copied byte for byte from the file you loaded. |
| Size of the built file | The same as the file you loaded when only the waves change. With the screen pictures on, the part of the firmware that holds them has to be packed again, so the file comes out a little smaller or larger; the page shows the old and the new size before you download. That also makes the build take about twenty seconds. |
| What does not change | Every other machine, and everything else on the screen. Your projects, patterns and sounds, which live on the instrument, not in the firmware file. They are not rewritten, but any that use a changed WAVE value will sound different. |
| Checks before download | Eight, all shown under "Details": the loaded file still verifies; no two tools write the same bytes; every tool stayed inside the regions it declared (stray bytes are discarded, not applied); the new file decodes again with valid checksums; the size it came out at; every section matches the official OS 1.41 SHA-256 fingerprints outside the allowed regions; what the file now contains; and its SHA-256. A failed check means no download. |
| Confirmed on hardware | 2026-09-21, one unit on OS 1.41, measured from its audio output over USB audio with notes sent over USB MIDI. A saw and a square came out within 0.009 of the harmonics that went in over h1..h40; every untouched WAVE value measured identical to factory (0.000); a build stacked on an already modified image changed only the wave it addressed, and left the earlier one bit-identical. Screen pictures: 2026-09-22, same unit: a square, a triangle, a saw and a 25 % pulse placed at WAVE 4, 8, 12 and 124 were drawn on the screen as those shapes, the in-between values morphed, and untouched values kept the original pictures. |
| Future OS versions | OS 1.41 only. Where the waves sit was found by measuring, not from documentation, so another OS release can move them. Other versions are refused rather than patched blindly. |
| Combines with | Any tool whose byte regions are disjoint from this one's. The site declares the regions of every tool up front, checks them before you open a tool and again before the build, and refuses an overlap. Disjoint bytes mean the tools cannot corrupt each other; they do not mean the combination makes musical sense. |

## What this repository does not contain

No Elektron firmware, no factory sounds and no excerpts of either. You supply your own official
file; everything the page shows is read from that file on your own computer. Do not add firmware
files, images built with the tool, or anything extracted from them to this repository, to issues
or to pull requests.

## What is here

| Folder | Contents |
| --- | --- |
| `web/` | The site: plain HTML, CSS and JavaScript modules. No build step, no frameworks, no external requests. `web/README.md` explains the structure and how to add a tool. |
| `web/test/` | Node tests. Several of them need your own copy of the official file on disk; none is included. |
| `tools/` | `din_loopback_test.py` (Windows): checks that your MIDI interface can carry a whole firmware file over a DIN cable without losing data, by looping its MIDI OUT to its own MIDI IN. Worth running before you rely on that interface to restore the official firmware. |

## Run it locally

```
python web/dev/serve.py 8765
```

Then open http://127.0.0.1:8765/ . The small server only exists to stop the browser from caching
JavaScript modules while you edit them.

```
node web/test/dsp.test.mjs
```

runs the tests that need no firmware file.

## Credits

- [elektron-firmware-tool](https://github.com/mischa85/elektron-firmware-tool) by mischa85 (MIT) -
  the file-format groundwork that Elektron firmware projects build on.
- [dn2_firmware_explore](https://angellinares.github.io/dn2_firmware_explore/) - the model for a
  browser-only tool that works on the owner's own file.

## License

MIT - see `LICENSE`. The license covers the code and text in this repository only.
