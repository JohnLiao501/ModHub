"""用标准库生成圆环字体：python tests/modhub-progress-font.py <输出目录> [CSS路径]。"""

import base64
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import zlib


MODHUB_FRAMES = 120
MODHUB_EM = 1024
MODHUB_FIRST_CODEPOINT = 0xE000
MODHUB_RADIUS = 13
MODHUB_HALF_STROKE = 1.25
MODHUB_CIRCUMFERENCE = 2 * math.pi * MODHUB_RADIUS


def ease_in_out(progress):
    """求 cubic-bezier(.42, 0, .58, 1) 的纵坐标。"""
    if progress in (0, .5, 1):
        return progress
    low, high = 0.0, 1.0
    for _ in range(45):
        parameter = (low + high) / 2
        x = 3 * (1 - parameter) ** 2 * parameter * .42 + 3 * (1 - parameter) * parameter ** 2 * .58 + parameter ** 3
        if x < progress:
            low = parameter
        else:
            high = parameter
    return 3 * (1 - parameter) * parameter ** 2 + parameter ** 3


def frame_parameters(index):
    progress = index / MODHUB_FRAMES
    if progress <= .5:
        eased = ease_in_out(progress * 2)
        dash, offset = 1 + 59 * eased, -8 * eased
    else:
        eased = ease_in_out((progress - .5) * 2)
        dash, offset = 60 - 59 * eased, -8 - 74 * eased
    # 闭合路径仍在 [0, 周长] 上截断 dash，不能把超出的弧段绕回起点。
    period = dash + 82
    intervals = []
    for cycle in range(-2, 3):
        start = -offset + cycle * period
        end = start + dash
        if end > 0 and start < MODHUB_CIRCUMFERENCE:
            intervals.append((max(0, start), min(MODHUB_CIRCUMFERENCE, end)))
    return {
        'index': index,
        'codepoint': MODHUB_FIRST_CODEPOINT + index,
        'time_ms': progress * 2000,
        'rotation_degrees': -90 + 360 * progress,
        'dash_length': dash,
        'dash_gap': 82,
        'dash_offset': offset,
        'intervals': intervals,
    }


def arc_contour(start, end, rotation):
    start = start / MODHUB_RADIUS + rotation
    end = end / MODHUB_RADIUS + rotation
    steps = max(1, math.ceil((end - start) / .035))
    points = []

    def add(x, y):
        point = (round((16 + x) * 32), round((16 - y) * 32))
        if not points or point != points[-1]:
            points.append(point)

    for step in range(steps + 1):
        angle = start + (end - start) * step / steps
        add((MODHUB_RADIUS + MODHUB_HALF_STROKE) * math.cos(angle), (MODHUB_RADIUS + MODHUB_HALF_STROKE) * math.sin(angle))
    # 圆弧两端的半圆帽与原 SVG round linecap 具有相同方向。
    for step in range(1, 28):
        angle = math.pi * step / 27
        add(MODHUB_RADIUS * math.cos(end) + MODHUB_HALF_STROKE * math.cos(end + angle), MODHUB_RADIUS * math.sin(end) + MODHUB_HALF_STROKE * math.sin(end + angle))
    for step in range(1, steps + 1):
        angle = end - (end - start) * step / steps
        add((MODHUB_RADIUS - MODHUB_HALF_STROKE) * math.cos(angle), (MODHUB_RADIUS - MODHUB_HALF_STROKE) * math.sin(angle))
    for step in range(1, 28):
        angle = math.pi + math.pi * step / 27
        add(MODHUB_RADIUS * math.cos(start) + MODHUB_HALF_STROKE * math.cos(start + angle), MODHUB_RADIUS * math.sin(start) + MODHUB_HALF_STROKE * math.sin(start + angle))
    if points[-1] == points[0]:
        points.pop()
    return points


def encode_glyph(contours):
    if not contours:
        return b'', (0, 0, 0, 0), 0
    points = [point for contour in contours for point in contour]
    bounds = (min(x for x, _ in points), min(y for _, y in points), max(x for x, _ in points), max(y for _, y in points))
    header = struct.pack('>hhhhh', len(contours), *bounds)
    count = 0
    for contour in contours:
        count += len(contour)
        header += struct.pack('>H', count - 1)
    header += b'\0\0'
    flags, x_bytes, y_bytes = bytearray(), bytearray(), bytearray()
    previous = (0, 0)
    for point in points:
        flag = 1
        for axis, output in [(0, x_bytes), (1, y_bytes)]:
            delta = point[axis] - previous[axis]
            short_flag, positive_flag = (2, 16) if axis == 0 else (4, 32)
            if delta == 0:
                flag |= positive_flag
            elif abs(delta) <= 255:
                flag |= short_flag
                if delta > 0:
                    flag |= positive_flag
                output.append(abs(delta))
            else:
                output.extend(struct.pack('>h', delta))
        flags.append(flag)
        previous = point
    return header + flags + x_bytes + y_bytes, bounds, len(points)


def padded(data):
    return data + b'\0' * (-len(data) % 4)


def checksum(data):
    data = padded(data)
    return sum(struct.unpack('>' + 'I' * (len(data) // 4), data)) & 0xFFFFFFFF


def name_table():
    names = {1: 'ModHub Progress', 2: 'Regular', 3: 'ModHubProgress-1.000', 4: 'ModHub Progress', 5: 'Version 1.000', 6: 'ModHubProgress'}
    records, strings = b'', b''
    for name_id, text in names.items():
        encoded = text.encode('utf-16-be')
        records += struct.pack('>6H', 3, 1, 0x0409, name_id, len(encoded), len(strings))
        strings += encoded
    return struct.pack('>3H', 0, len(names), 6 + len(records)) + records + strings


def font_tables(frames):
    glyphs = [(b'', (0, 0, 0, 0), 0)]
    max_contours = 0
    for frame in frames:
        contours = [arc_contour(start, end, math.radians(frame['rotation_degrees'])) for start, end in frame['intervals']]
        max_contours = max(max_contours, len(contours))
        glyphs.append(encode_glyph(contours))
    glyf, offsets = b'', [0]
    for glyph, _, _ in glyphs:
        glyf += padded(glyph)
        offsets.append(len(glyf))
    occupied = [bounds for _, bounds, points in glyphs if points]
    bounds = (min(box[0] for box in occupied), min(box[1] for box in occupied), max(box[2] for box in occupied), max(box[3] for box in occupied))
    head = struct.pack('>4I2H2Q4h2H3h', 0x10000, 0x10000, 0, 0x5F0F3CF5, 3, MODHUB_EM, 3874521600, 3874521600, *bounds, 0, 8, 2, 1, 0)
    hhea = struct.pack('>I3hH11hH', 0x10000, MODHUB_EM, 0, 0, MODHUB_EM, min(box[0] for box in occupied), min(MODHUB_EM - box[2] for box in occupied), max(box[2] for box in occupied), 1, 0, 0, 0, 0, 0, 0, 0, len(glyphs))
    maxp = struct.pack('>I14H', 0x10000, len(glyphs), max(points for _, _, points in glyphs), max_contours, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0)
    hmtx = b''.join(struct.pack('>Hh', MODHUB_EM, box[0]) for _, box, _ in glyphs)
    # 格式 4 的连续 BMP 私用区映射，终止段映射到 .notdef。
    cmap4 = struct.pack('>7H', 4, 32, 0, 4, 4, 1, 0)
    cmap4 += struct.pack('>9H', MODHUB_FIRST_CODEPOINT + MODHUB_FRAMES - 1, 0xFFFF, 0, MODHUB_FIRST_CODEPOINT, 0xFFFF, (1 - MODHUB_FIRST_CODEPOINT) & 0xFFFF, 1, 0, 0)
    cmap = struct.pack('>HHHHIHHI', 0, 2, 0, 3, 20, 3, 1, 20) + cmap4
    os2 = struct.pack('>Hh3H11h', 0, MODHUB_EM, 400, 5, 0, 650, 600, 0, 140, 650, 600, 0, 480, 50, 512, 0)
    os2 += b'\0' * 10 + struct.pack('>4I', 0, 1 << 28, 0, 0) + b'MDHB'
    os2 += struct.pack('>3H3h2H', 0x40, MODHUB_FIRST_CODEPOINT, MODHUB_FIRST_CODEPOINT + MODHUB_FRAMES - 1, MODHUB_EM, 0, 0, MODHUB_EM, 0)
    post = struct.pack('>IIhh5I', 0x30000, 0, 0, 0, 1, 0, 0, 0, 0)
    tables = {'OS/2': os2, 'cmap': cmap, 'glyf': glyf, 'head': head, 'hhea': hhea, 'hmtx': hmtx, 'loca': struct.pack('>' + 'I' * len(offsets), *offsets), 'maxp': maxp, 'name': name_table(), 'post': post}
    assert len(head) == 54 and len(hhea) == 36 and len(maxp) == 32 and len(os2) == 78 and len(post) == 32
    return tables


def sfnt_bytes(tables):
    count = len(tables)
    power = 2 ** (count.bit_length() - 1)
    header = struct.pack('>I4H', 0x10000, count, power * 16, power.bit_length() - 1, count * 16 - power * 16)
    directory, body = b'', b''
    for tag, table in sorted(tables.items()):
        table_checksum = checksum(table[:8] + b'\0' * 4 + table[12:]) if tag == 'head' else checksum(table)
        directory += struct.pack('>4s3I', tag.encode('ascii'), table_checksum, 12 + count * 16 + len(body), len(table))
        body += padded(table)
    return header + directory + body


def woff_bytes(tables):
    sfnt = sfnt_bytes(tables)
    adjustment = (0xB1B0AFBA - checksum(sfnt)) & 0xFFFFFFFF
    tables['head'] = tables['head'][:8] + struct.pack('>I', adjustment) + tables['head'][12:]
    assert checksum(sfnt_bytes(tables)) == 0xB1B0AFBA
    count = len(tables)
    directory, body = b'', b''
    for tag, table in sorted(tables.items()):
        compressed = zlib.compress(table, 9)
        encoded = compressed if len(compressed) < len(table) else table
        table_checksum = checksum(table[:8] + b'\0' * 4 + table[12:]) if tag == 'head' else checksum(table)
        directory += struct.pack('>4s4I', tag.encode('ascii'), 44 + count * 20 + len(body), len(encoded), len(table), table_checksum)
        body += padded(encoded)
    header = struct.pack('>4sIIHHIHH5I', b'wOFF', 0x10000, 44 + len(directory) + len(body), count, 0, len(sfnt), 1, 0, 0, 0, 0, 0, 0)
    result = header + directory + body
    # 回读每份表，校验压缩、目录长度与 SFNT 总校验和。
    recovered = {}
    for index in range(count):
        tag, offset, compressed_length, original_length, original_checksum = struct.unpack_from('>4s4I', result, 44 + index * 20)
        encoded = result[offset:offset + compressed_length]
        table = zlib.decompress(encoded) if compressed_length < original_length else encoded
        tag = tag.decode('ascii')
        assert len(table) == original_length and table == tables[tag]
        checksum_table = table[:8] + b'\0' * 4 + table[12:] if tag == 'head' else table
        assert checksum(checksum_table) == original_checksum
        recovered[tag] = table
    assert len(sfnt_bytes(recovered)) == len(sfnt) and checksum(sfnt_bytes(recovered)) == 0xB1B0AFBA
    return result


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit('用法：python tests/modhub-progress-font.py <输出目录> [CSS路径]。请指定 QA 输出目录，避免测试目录遗留生成文件。')
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=True)
    frames = [frame_parameters(index) for index in range(MODHUB_FRAMES)]
    assert frames[0]['intervals'][0][0] == 0 and abs(frames[0]['dash_length'] - 1) < 1e-10
    assert abs(frames[60]['dash_length'] - 60) < 1e-10 and abs(frames[60]['dash_offset'] + 8) < 1e-10
    assert frames[90]['intervals'] == [(45.0, 75.5)]
    font = woff_bytes(font_tables(frames))
    if len(sys.argv) == 3:
        css = Path(sys.argv[2]).read_text(encoding='utf-8')
        embedded = re.search(r'data:font/woff;base64,([A-Za-z0-9+/=]+)', css)
        assert embedded is not None, 'CSS 中未找到自有圆环字体。'
        assert base64.b64decode(embedded.group(1), validate=True) == font, 'CSS 内嵌字体与生成器重建字节不一致。'
    (output / 'font.woff').write_bytes(font)
    metadata = {
        'family': 'ModHub Progress', 'format': 'WOFF1', 'frames': MODHUB_FRAMES,
        'units_per_em': MODHUB_EM, 'advance_width': MODHUB_EM,
        'ascent': MODHUB_EM, 'descent': 0, 'duration_ms': 2000,
        'codepoint_first': MODHUB_FIRST_CODEPOINT, 'codepoint_last': MODHUB_FIRST_CODEPOINT + MODHUB_FRAMES - 1,
        'svg': {'viewBox': '0 0 32 32', 'cx': 16, 'cy': 16, 'radius': MODHUB_RADIUS, 'stroke_width': MODHUB_HALF_STROKE * 2, 'linecap': 'round', 'circumference': MODHUB_CIRCUMFERENCE},
        'timing': 'cubic-bezier(.42, 0, .58, 1)', 'sha256': hashlib.sha256(font).hexdigest(),
        'font_bytes': len(font), 'frame_parameters': frames,
        'sources': ['https://www.w3.org/TR/WOFF/', 'https://www.w3.org/TR/SVG2/painting.html#StrokeDashing', 'https://learn.microsoft.com/en-us/typography/opentype/spec/otff'],
    }
    (output / 'font.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'已生成 {output / "font.woff"}：{len(font)} 字节，{MODHUB_FRAMES} 帧，全部字体表回读校验通过。')


if __name__ == '__main__':
    main()
