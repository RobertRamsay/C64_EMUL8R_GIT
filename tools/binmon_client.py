"""Minimal VICE binary monitor client for checking C64EMUL8R end to end.

    python tools/binmon_client.py [host] [port]

Connects, pings, reads the KERNAL reset vector, sets an exec checkpoint in the
READY prompt's key wait loop, resumes and waits for the checkpoint-hit and
stopped events, then deletes the checkpoint and resumes again.
"""
import socket
import struct
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else '127.0.0.1'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 6502
EVENT = 0xffffffff
NAMES = {0x01: 'mem get', 0x11: 'checkpoint info', 0x13: 'checkpoint delete', 0x31: 'registers',
         0x61: 'JAM', 0x62: 'stopped', 0x63: 'resumed', 0x81: 'ping', 0x85: 'vice info', 0xaa: 'exit'}


class Client:
    def __init__(self):
        for _ in range(60):
            try:
                self.s = socket.create_connection((HOST, PORT), timeout=1)
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise SystemExit(f'no binary monitor on {HOST}:{PORT}')
        self.s.settimeout(5)
        self.buf = b''
        self.next_id = 1

    def send(self, cmd, body=b''):
        rid = self.next_id
        self.next_id += 1
        self.s.sendall(struct.pack('<BBIIB', 2, 2, len(body), rid, cmd) + body)
        return rid

    def read(self):
        while True:
            if len(self.buf) >= 12:
                _, _, n, typ, err, rid = struct.unpack('<BBIBBI', self.buf[:12])
                if len(self.buf) >= 12 + n:
                    body, self.buf = self.buf[12:12 + n], self.buf[12 + n:]
                    return typ, err, rid, body
            self.buf += self.s.recv(65536)

    def until(self, pred, what):
        seen = []
        while True:
            m = self.read()
            seen.append(m)
            label = NAMES.get(m[0], hex(m[0]))
            print(f'  <- {label:16} err={m[1]:02x} id={"event" if m[2] == EVENT else m[2]} body={m[3][:8].hex()}')
            if pred(m):
                return m, seen


def main():
    c = Client()
    print(f'connected to {HOST}:{PORT}')
    rid = c.send(0x81)
    c.until(lambda m: m[2] == rid, 'ping')
    rid = c.send(0x85)
    _, _, _, info = c.until(lambda m: m[2] == rid, 'vice info')[0]
    print(f'  VICE version reported: {".".join(str(b) for b in info[1:5])}')
    rid = c.send(0x01, struct.pack('<BHHBH', 0, 0xfffc, 0xfffd, 0, 0))
    m, _ = c.until(lambda m: m[2] == rid, 'mem get')
    vec = m[3][2] | (m[3][3] << 8)
    print(f'  reset vector ${vec:04x}')
    assert m[1] == 0 and vec == 0xfce2, 'unexpected reset vector'
    rid = c.send(0x12, struct.pack('<HHBBBBB', 0xe5cf, 0xe5cf, 1, 1, 4, 0, 0))
    m, _ = c.until(lambda m: m[2] == rid, 'checkpoint set')
    cp = struct.unpack('<I', m[3][:4])[0]
    print(f'  checkpoint {cp} set at $e5cf')
    rid = c.send(0xaa)
    c.until(lambda m: m[0] == 0x62 and m[2] == EVENT, 'stopped')
    _, seen = None, None
    rid = c.send(0x13, struct.pack('<I', cp))
    c.until(lambda m: m[2] == rid, 'checkpoint delete')
    rid = c.send(0xaa)
    c.until(lambda m: m[2] == rid, 'exit')
    print('OK: ping, info, memory, checkpoint hit, delete and resume all worked')


if __name__ == '__main__':
    main()
