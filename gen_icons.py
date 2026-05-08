import struct, zlib, os

def make_png(size, r, g, b):
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            raw += bytes([r, g, b])
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 9)) +
            chunk(b'IEND', b''))

base = 'C:/Users/17633/WorkBuddy/20260502231654/NoteApp/src-tauri/icons'
os.makedirs(base, exist_ok=True)

# PNG icons (solid blue #3B82F6)
for size in [32, 128]:
    path = os.path.join(base, f'{size}x{size}.png')
    with open(path, 'wb') as f:
        f.write(make_png(size, 59, 130, 246))
    print(f'Created {size}x{size}.png')

with open(os.path.join(base, '128x128@2x.png'), 'wb') as f:
    f.write(make_png(256, 59, 130, 246))
print('Created 128x128@2x.png')

# icon.ico (ICO format with 32x32 PNG inside)
png32 = make_png(32, 59, 130, 246)
with open(os.path.join(base, 'icon.ico'), 'wb') as f:
    f.write(struct.pack('<HHH', 0, 1, 1))  # ICO header
    f.write(struct.pack('<BBBBHHII',
                        0, 0, 0, 0, 1, 32,
                        len(png32), 6 + 16))
    f.write(png32)
print('Created icon.ico')
print('Done!')
