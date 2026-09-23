"""Flash a Syntakt OS file from a Windows computer over USB, without pressing YES on the instrument.

Elektron Transfer sends an OS file and the Syntakt then asks "UPGRADE OS NOW?". This script sends the
same file over the same USB MIDI connection and confirms the upgrade itself, so you can flash while
the instrument is out of reach. Everything else is the Syntakt's own OS upgrade: it checks the whole
file first and only then writes it.

    python syntakt_os_flash.py check                 talk to the Syntakt, change nothing
    python syntakt_os_flash.py probe FILE.syx        send the start of FILE, then cancel: changes nothing
    python syntakt_os_flash.py flash FILE.syx        send FILE and flash it (asks you to type FLASH)
    python syntakt_os_flash.py flash FILE.syx --yes-flash   the same without the question (scripts)

Before you use it:
  * Make sure you can put the official OS back (the Syntakt manual: Early Startup Menu, OS UPGRADE,
    over a MIDI DIN cable). din_loopback_test.py in this folder checks your MIDI interface for that.
  * Close Elektron Transfer: only one program can use the Syntakt's MIDI port.
  * Flashing takes about 7 seconds; the Syntakt restarts by itself. Do not switch it off before that.

Windows only (WinMM), Python 3.8+, no packages. The instrument must be on and connected over USB,
in normal operation (not in the Early Startup Menu). Unofficial, not affiliated with Elektron; you
flash at your own risk. Tested with a Syntakt on OS 1.41 in September 2026.
"""
import argparse, ctypes, hashlib, queue, struct, sys, threading, time, zlib
from ctypes import wintypes

PORT = "Elektron Syntakt"
OFFICIAL = {"8e2488f462c4a5656396a895f113bcd415e9900fa8709340dccf45d4cb9ed19e": "the official Syntakt OS 1.41 file"}

# ---- MIDI over WinMM -----------------------------------------------------------------------

winmm = ctypes.WinDLL("winmm")
CALLBACK_FUNCTION, MIM_LONGDATA, MIM_LONGERROR = 0x30000, 0x3C4, 0x3C6
HDR = bytes((0xF0, 0x00, 0x20, 0x3C, 0x10, 0x00))   # SysEx, Elektron, the connection Transfer uses


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


def pack7(data):
    """8 bytes -> 7-bit SysEx: one byte of high bits, then seven low parts."""
    out = bytearray()
    for g in range(0, len(data), 7):
        grp = data[g:g + 7]
        out.append(sum(1 << (6 - k) for k, v in enumerate(grp) if v & 0x80))
        out.extend(v & 0x7F for v in grp)
    return bytes(out)


def unpack7(data):
    out = bytearray()
    for g in range(0, len(data), 8):
        grp = data[g:g + 8]
        for k, v in enumerate(grp[1:]):
            out.append(v | (0x80 if grp[0] & (1 << (6 - k)) else 0))
    return bytes(out)


def find_port(out):
    n = winmm.midiOutGetNumDevs() if out else winmm.midiInGetNumDevs()
    for i in range(n):
        caps = OUTCAPS() if out else INCAPS()
        (winmm.midiOutGetDevCapsW if out else winmm.midiInGetDevCapsW)(i, ctypes.byref(caps), ctypes.sizeof(caps))
        if caps.szPname == PORT:
            return i
    sys.exit('No MIDI port "%s". Switch the Syntakt on, connect it over USB and close Elektron Transfer.' % PORT)


class Connection:
    def __init__(self, nbuf=32, bufsize=8192):
        self.q, self.closing, self.rx, self.lock, self.seq = queue.Queue(), False, bytearray(), threading.Lock(), 1
        CB = ctypes.WINFUNCTYPE(None, ctypes.c_void_p, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)
        self._cb = CB(lambda h, m, i, p1, p2: self.q.put(p1) if m in (MIM_LONGDATA, MIM_LONGERROR) else None)
        self.hin, self.hout = ctypes.c_void_p(), ctypes.c_void_p()
        if winmm.midiInOpen(ctypes.byref(self.hin), find_port(False), self._cb, None, CALLBACK_FUNCTION):
            sys.exit("The Syntakt's MIDI port is busy. Close Elektron Transfer and try again.")
        self.bufs, self.hdrs = [], {}
        for _ in range(nbuf):
            data = ctypes.create_string_buffer(bufsize)
            hdr = MIDIHDR(lpData=ctypes.cast(data, ctypes.c_void_p), dwBufferLength=bufsize)
            winmm.midiInPrepareHeader(self.hin, ctypes.byref(hdr), ctypes.sizeof(hdr))
            winmm.midiInAddBuffer(self.hin, ctypes.byref(hdr), ctypes.sizeof(hdr))
            self.bufs.append(data)
            self.hdrs[ctypes.addressof(hdr)] = hdr
        winmm.midiInStart(self.hin)
        if winmm.midiOutOpen(ctypes.byref(self.hout), find_port(True), None, None, 0):
            winmm.midiInClose(self.hin)
            sys.exit("The Syntakt's MIDI port is busy. Close Elektron Transfer and try again.")
        threading.Thread(target=self._recycle, daemon=True).start()

    def _recycle(self):
        while True:
            addr = self.q.get()
            if addr is None:
                return
            hdr = self.hdrs[addr]
            with self.lock:
                self.rx.extend(ctypes.string_at(hdr.lpData, hdr.dwBytesRecorded))
            if not self.closing:
                winmm.midiInAddBuffer(self.hin, ctypes.byref(hdr), ctypes.sizeof(hdr))

    def _send(self, msg):
        buf = ctypes.create_string_buffer(bytes(msg), len(msg))
        hdr = MIDIHDR(lpData=ctypes.cast(buf, ctypes.c_void_p), dwBufferLength=len(msg))
        winmm.midiOutPrepareHeader(self.hout, ctypes.byref(hdr), ctypes.sizeof(hdr))
        winmm.midiOutLongMsg(self.hout, ctypes.byref(hdr), ctypes.sizeof(hdr))
        while not hdr.dwFlags & 1:
            time.sleep(0.001)
        winmm.midiOutUnprepareHeader(self.hout, ctypes.byref(hdr), ctypes.sizeof(hdr))

    def request(self, typ, payload=b"", wait=1.5):
        """Send one request; return the payload of the Syntakt's reply to it, or None."""
        with self.lock:
            self.rx.clear()
        head = bytes(((self.seq >> 8) & 0x7F, self.seq & 0x7F, 0, 0, typ))
        self._send(HDR + pack7(head + bytes(payload)) + b"\xF7")
        self.seq = (self.seq + 1) & 0x3FFF
        end = time.time() + wait
        while time.time() < end:
            time.sleep(0.002)
            with self.lock:
                if b"\xF7" in self.rx:
                    break
        time.sleep(0.01)
        with self.lock:
            data = bytes(self.rx)
        i = 0
        while (a := data.find(b"\xF0", i)) >= 0 and (b := data.find(b"\xF7", a)) >= 0:
            m = data[a:b + 1]
            i = b + 1
            if m[:6] == HDR:
                body = unpack7(m[6:-1])
                if len(body) >= 5 and body[4] == (typ | 0x80):
                    return body[5:]
        return None

    def close(self):
        self.closing = True
        winmm.midiInStop(self.hin)
        winmm.midiInReset(self.hin)
        self.q.put(None)
        winmm.midiInClose(self.hin)
        winmm.midiOutClose(self.hout)


# ---- OS upgrade --------------------------------------------------------------------------

PING, START, WRITE, END = 0x01, 0x50, 0x51, 0x52


def start(c, size):              # size of the file, its kind, and "do not ask on the instrument"
    return c.request(START, struct.pack(">I", size) + b"sysex\0" + b"\x00", wait=2.0)


def write(c, data, offset, wait=3.0):
    crc = zlib.crc32(data, 0xFFFFFFFF)
    return c.request(WRITE, struct.pack(">III", crc, len(data), offset) + data, wait=wait)


def end(c, commit):              # 1 = write the received file now, 0 = cancel
    return c.request(END, bytes((commit,)), wait=2.0)


def read_file(path):
    data = open(path, "rb").read()
    if not (1_000_000 <= len(data) <= 8_000_000) or data[:4] != b"\xF0\x00\x20\x3C" or data[-1:] != b"\xF7":
        sys.exit("%s does not look like a Syntakt OS file (.syx from Elektron, or an image built from one)." % path)
    sha = hashlib.sha256(data).hexdigest()
    print("File:    %s (%d bytes)" % (path, len(data)))
    print("SHA-256: %s" % sha)
    print("This is %s." % OFFICIAL.get(sha, "NOT the official OS file (for example an image built with the workbench)"))
    return data


def cmd_check():
    c = Connection()
    try:
        ok = c.request(PING) is not None
    finally:
        c.close()
    print("The Syntakt answers." if ok else "No answer. Is the Syntakt in normal operation (not in the startup menu)?")
    return 0 if ok else 1


def cmd_probe(path):
    data = read_file(path)
    c = Connection()
    try:
        if start(c, len(data)) is None:
            print("No answer to the start of an upgrade.")
            return 1
        rep = write(c, data[:4096], 0)
        print("The Syntakt accepted the first 4 KB." if rep is not None else "No answer to the first block.")
        end(c, 0)
        print("Cancelled. Nothing was written.")
        return 0 if rep is not None else 1
    finally:
        c.close()


def cmd_flash(path, yes, chunk=16384):
    data = read_file(path)
    if not yes:
        print("\nThis replaces the OS of your Syntakt with the file above. The instrument does not ask again.")
        if input("Type FLASH to continue: ").strip() != "FLASH":
            print("Nothing sent.")
            return 1
    c = Connection()
    try:
        if start(c, len(data)) is None:
            print("No answer to the start of an upgrade. Nothing was written.")
            return 1
        off, t0, rep = 0, time.time(), None
        while off < len(data):
            block = data[off:off + chunk]
            rep = write(c, block, off)
            if rep is None or len(rep) < 5 or rep[4] in (2, 3):     # 2 = damaged block, 3 = error
                end(c, 0)
                print("The transfer failed at byte %d. Cancelled; nothing was written." % off)
                return 1
            off += len(block)
            print("\r  sent %3d%%" % (100 * off // len(data)), end="", flush=True)
        print("  (%.0f s)" % (time.time() - t0))
        if rep[4] != 1:                                             # 1 = the Syntakt checked the whole file
            end(c, 0)
            print("The Syntakt did not accept the file as a whole. Cancelled; nothing was written.")
            return 1
        end(c, 1)
        print("Flashing. The Syntakt restarts by itself in a few seconds. Do not switch it off before that.")
        return 0
    finally:
        c.close()


if __name__ == "__main__":
    if sys.platform != "win32":
        sys.exit("Windows only.")
    ap = argparse.ArgumentParser(description="Flash a Syntakt OS file over USB without pressing YES.")
    ap.add_argument("cmd", choices=["check", "probe", "flash"])
    ap.add_argument("file", nargs="?")
    ap.add_argument("--yes-flash", action="store_true", help="flash without asking you to type FLASH")
    a = ap.parse_args()
    if a.cmd != "check" and not a.file:
        ap.error("%s needs a .syx file" % a.cmd)
    sys.exit(cmd_check() if a.cmd == "check" else cmd_probe(a.file) if a.cmd == "probe" else cmd_flash(a.file, a.yes_flash))
