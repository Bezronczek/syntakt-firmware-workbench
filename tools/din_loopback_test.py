"""DIN loopback test: can this MIDI interface carry a full OS .syx without loss?

CABLING: interface MIDI OUT -> the SAME interface's MIDI IN, one DIN cable.
The Syntakt must NOT be on the other end of that cable: this script sends a
real firmware SysEx stream, and a running Syntakt would take it for an upgrade.

Guard: before anything else a 6-byte SysEx with the non-commercial id 0x7D
(ignored by every device) is sent; unless it comes straight back on the input
port, the script stops and sends nothing more.

usage: python din_loopback_test.py <file.syx> --port "<name of your MIDI interface>" [--settle 5] [--limit N]
  Run it without --port to list the MIDI ports Windows knows about.
  --settle S  wait S seconds after opening the port before sending (some interfaces drop a
              message shortly after the port is opened; 5 is a safe value)
  --limit N   send only the first N SysEx messages (quick trial)
Windows only (uses WinMM).
"""
import argparse, ctypes, queue, sys, threading, time
from ctypes import wintypes

winmm = ctypes.WinDLL("winmm")
CALLBACK_FUNCTION = 0x30000
MIM_LONGDATA = 0x3C4
MIM_LONGERROR = 0x3C6
EVENT_NAMES = {0x3C1: "OPEN", 0x3C2: "CLOSE", 0x3C3: "DATA", 0x3C4: "LONGDATA", 0x3C5: "ERROR", 0x3C6: "LONGERROR", 0x3CC: "MOREDATA"}
BUF_SIZE, BUF_COUNT = 4096, 64
WIRE_BYTES_PER_S = 3125.0          # 31250 baud, 10 bits per byte
PACE = 1.10                        # send 10 % slower than the wire drains


class MIDIHDR(ctypes.Structure):
    _fields_ = [("lpData", ctypes.c_void_p), ("dwBufferLength", wintypes.DWORD),
                ("dwBytesRecorded", wintypes.DWORD), ("dwUser", ctypes.c_void_p),
                ("dwFlags", wintypes.DWORD), ("lpNext", ctypes.c_void_p),
                ("reserved", ctypes.c_void_p), ("dwOffset", wintypes.DWORD),
                ("dwReserved", ctypes.c_void_p * 8)]


class OUTCAPS(ctypes.Structure):
    _fields_ = [("wMid", wintypes.WORD), ("wPid", wintypes.WORD), ("vDriverVersion", wintypes.UINT),
                ("szPname", wintypes.WCHAR * 32), ("wTechnology", wintypes.WORD), ("wVoices", wintypes.WORD),
                ("wNotes", wintypes.WORD), ("wChannelMask", wintypes.WORD), ("dwSupport", wintypes.DWORD)]


class INCAPS(ctypes.Structure):
    _fields_ = [("wMid", wintypes.WORD), ("wPid", wintypes.WORD), ("vDriverVersion", wintypes.UINT),
                ("szPname", wintypes.WCHAR * 32), ("dwSupport", wintypes.DWORD)]


def find_port(name, out):
    n = winmm.midiOutGetNumDevs() if out else winmm.midiInGetNumDevs()
    for i in range(n):
        caps = OUTCAPS() if out else INCAPS()
        (winmm.midiOutGetDevCapsW if out else winmm.midiInGetDevCapsW)(i, ctypes.byref(caps), ctypes.sizeof(caps))
        if caps.szPname == name:
            return i
    sys.exit(f'no MIDI {"OUT" if out else "IN"} port named "{name}"')


def check(rc, what):
    if rc:
        sys.exit(f"{what} failed, MMSYSERR {rc}")


def split_sysex(raw):
    msgs, i = [], 0
    while (a := raw.find(b"\xf0", i)) >= 0:
        b = raw.find(b"\xf7", a)
        if b < 0:
            break
        msgs.append(raw[a:b + 1])
        i = b + 1
    return msgs


ap = argparse.ArgumentParser()
ap.add_argument("syx")
ap.add_argument("--port")
ap.add_argument("--limit", type=int, default=0)
ap.add_argument("--settle", type=float, default=0.0, help="seconds to wait after the probe before sending")
ap.add_argument("--pace", type=float, default=PACE, help="1.0 = wire speed; higher = slower")
ap.add_argument("--skip", type=int, default=0, help="skip the first N messages")
args = ap.parse_args()
if not args.port:
    names = []
    for i in range(winmm.midiOutGetNumDevs()):
        caps = OUTCAPS()
        winmm.midiOutGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps))
        names.append(caps.szPname)
    print("choose your interface with --port. MIDI OUT ports found:")
    for n in names:
        print("  " + n)
    sys.exit(1)
if "elektron" in args.port.lower() or "syntakt" in args.port.lower():
    sys.exit("refusing: this test must never be pointed at the instrument's own port")

msgs = split_sysex(open(args.syx, "rb").read())[args.skip:]
if args.limit:
    msgs = msgs[:args.limit]
expected = b"".join(msgs)

# ---- input: a pool of buffers, recycled from the main thread ----
received = bytearray()
done_q = queue.Queue()
CB = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)


events = {}


def on_midi_in(h, msg, inst, p1, p2):
    events[msg] = events.get(msg, 0) + 1
    if msg in (MIM_LONGDATA, MIM_LONGERROR):   # either way the buffer comes back to us
        done_q.put(p1)


cb = CB(on_midi_in)
hin, hout = ctypes.c_void_p(), ctypes.c_void_p()
check(winmm.midiInOpen(ctypes.byref(hin), find_port(args.port, False), cb, None, CALLBACK_FUNCTION), "midiInOpen")
bufs, hdrs = [], {}
for _ in range(BUF_COUNT):
    data = ctypes.create_string_buffer(BUF_SIZE)
    hdr = MIDIHDR(lpData=ctypes.cast(data, ctypes.c_void_p), dwBufferLength=BUF_SIZE)
    check(winmm.midiInPrepareHeader(hin, ctypes.byref(hdr), ctypes.sizeof(hdr)), "midiInPrepareHeader")
    check(winmm.midiInAddBuffer(hin, ctypes.byref(hdr), ctypes.sizeof(hdr)), "midiInAddBuffer")
    bufs.append(data)
    hdrs[ctypes.addressof(hdr)] = hdr
check(winmm.midiInStart(hin), "midiInStart")
check(winmm.midiOutOpen(ctypes.byref(hout), find_port(args.port, True), None, None, 0), "midiOutOpen")


def receiver():
    """Own thread: input buffers must be recycled no matter what the sender is doing."""
    while True:
        addr = done_q.get()
        if addr is None:
            return
        hdr = hdrs[addr]
        if hdr.dwBytesRecorded:
            received.extend(ctypes.string_at(hdr.lpData, hdr.dwBytesRecorded))
        if not closing:
            winmm.midiInAddBuffer(hin, ctypes.byref(hdr), ctypes.sizeof(hdr))


def drain():
    time.sleep(0.002)


rx = threading.Thread(target=receiver, daemon=True)
rx.start()


def send(msg):
    data = ctypes.create_string_buffer(msg, len(msg))
    hdr = MIDIHDR(lpData=ctypes.cast(data, ctypes.c_void_p), dwBufferLength=len(msg), dwBytesRecorded=len(msg))
    check(winmm.midiOutPrepareHeader(hout, ctypes.byref(hdr), ctypes.sizeof(hdr)), "midiOutPrepareHeader")
    check(winmm.midiOutLongMsg(hout, ctypes.byref(hdr), ctypes.sizeof(hdr)), "midiOutLongMsg")
    while winmm.midiOutUnprepareHeader(hout, ctypes.byref(hdr), ctypes.sizeof(hdr)) == 65:  # MIDIERR_STILLPLAYING
        time.sleep(0.001)


closing = False
try:
    # ---- guard: prove the cable is a loopback before sending real data ----
    probe = bytes([0xF0, 0x7D, 0x4C, 0x4F, 0x4F, 0x50, 0xF7])
    send(probe)
    t0 = time.time()
    while time.time() - t0 < 2.0 and bytes(received) != probe:
        drain()
        time.sleep(0.01)
    if bytes(received) != probe:
        sys.exit(f"probe did not come back (got {bytes(received).hex() or 'nothing'}): "
                 "OUT is not looped to IN. Nothing else was sent.")
    received.clear()
    print("loopback confirmed; sending", len(msgs), "messages,", len(expected), "bytes,",
          f"~{len(expected) / WIRE_BYTES_PER_S * PACE / 60:.1f} min")

    time.sleep(args.settle)
    start = time.time()
    sent = 0
    worst_send = worst_late = 0.0
    for n, m in enumerate(msgs, 1):
        t = time.time()
        send(m)
        worst_send = max(worst_send, time.time() - t)
        sent += len(m)
        due = start + sent / WIRE_BYTES_PER_S * args.pace
        worst_late = max(worst_late, time.time() - due)
        while time.time() < due:
            time.sleep(0.002)
        if n % 1000 == 0:
            print(f"  {n}/{len(msgs)} sent, {len(received)} B back, t={time.time() - start:6.1f}s, "
                  f"slowest send {worst_send * 1000:.0f} ms, worst lateness {worst_late * 1000:.0f} ms", flush=True)
            worst_send = worst_late = 0.0
    t0 = time.time()
    while time.time() - t0 < 3.0 and len(received) < len(expected):
        time.sleep(0.01)
finally:
    closing = True
    winmm.midiOutReset(hout); winmm.midiOutClose(hout)
    winmm.midiInStop(hin); winmm.midiInReset(hin); winmm.midiInClose(hin)
    done_q.put(None)

got = bytes(received)
print("driver events:", {EVENT_NAMES.get(k, hex(k)): v for k, v in events.items()})
got_msgs = split_sysex(got)
want = {m: i for i, m in enumerate(msgs)}
missing = sorted(set(range(len(msgs))) - {want[m] for m in got_msgs if m in want})
alien = [m for m in got_msgs if m not in want]
print(f"messages: sent {len(msgs)}, received {len(got_msgs)}, missing {len(missing)}, corrupt/unknown {len(alien)}")
if missing:
    print("  missing indexes (first 20):", missing[:20])
for m in alien[:3]:
    print(f"  unknown message, {len(m)} B: {m[:24].hex()}...")
if got == expected:
    print(f"PASS: {len(got)} bytes returned identical in {time.time() - start:.0f} s")
else:
    first = next((i for i, (x, y) in enumerate(zip(got, expected)) if x != y), min(len(got), len(expected)))
    print(f"FAIL: sent {len(expected)} B, got {len(got)} B, first difference at byte {first} "
          f"(message #{expected[:first].count(0xF7) + 1})")
    sys.exit(1)
