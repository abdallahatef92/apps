import sys, zipfile, re
def col2n(c):
    n = 0
    for ch in c: n = n * 26 + ord(ch) - 64
    return n
z = zipfile.ZipFile(sys.argv[1]); probs = []
st = z.read('xl/styles.xml').decode(); nxf = int(re.search(r'<cellXfs count="(\d+)"', st).group(1))
wbx = z.read('xl/workbook.xml').decode()
for dn in re.findall(r'<definedName[^>]*>([^<]*)</definedName>', wbx):
    if '#REF' in dn or not dn.strip(): probs.append('bad defined name ' + dn)
for n in sorted(x for x in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', x)):
    x = z.read(n).decode()
    rows = [int(r) for r in re.findall(r'<row r="(\d+)"', x)]
    if rows != sorted(set(rows)): probs.append(f'{n}: rows out of order / duplicate')
    for rm in re.finditer(r'<row r="(\d+)"[^>]*>(.*?)</row>', x):
        cs = [col2n(re.match(r'([A-Z]+)', c).group(1)) for c in re.findall(r'<c r="([A-Z]+\d+)"', rm.group(2))]
        if cs != sorted(set(cs)): probs.append(f'{n}: cells out of order in row {rm.group(1)}'); break
    for s_ in re.findall(r' s="(\d+)"', x):
        if int(s_) >= nxf: probs.append(f'{n}: style index {s_} >= {nxf}'); break
    rects = []
    for a, b in re.findall(r'<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"', x):
        ca, ra = re.match(r'([A-Z]+)(\d+)', a).groups(); cb, rb = re.match(r'([A-Z]+)(\d+)', b).groups()
        rects.append((col2n(ca), int(ra), col2n(cb), int(rb)))
    rects.sort()
    for i in range(len(rects)):
        for j in range(i + 1, len(rects)):
            A, B = rects[i], rects[j]
            if B[0] > A[2]: break
            if not (B[1] > A[3] or B[3] < A[1] or B[0] > A[2] or B[2] < A[0]): probs.append(f'{n}: overlapping merges {A} {B}')
    if len(re.findall(r'<autoFilter', x)) > 1: probs.append(f'{n}: more than one autoFilter')
print('\n'.join(probs[:20]) if probs else 'OK – rows, cells, styles, merges, names')
