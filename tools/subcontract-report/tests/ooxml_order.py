# Checks worksheet / sheetPr / workbook child-element order against the OOXML schema sequences (Excel rejects out-of-order parts).
import sys, zipfile, re
WS = ['sheetPr','dimension','sheetViews','sheetFormatPr','cols','sheetData','sheetCalcPr','sheetProtection','protectedRanges','scenarios','autoFilter','sortState',
      'dataConsolidate','customSheetViews','mergeCells','phoneticPr','conditionalFormatting','dataValidations','hyperlinks','printOptions','pageMargins','pageSetup',
      'headerFooter','rowBreaks','colBreaks','customProperties','cellWatches','ignoredErrors','smartTags','drawing','legacyDrawing','legacyDrawingHF','picture',
      'oleObjects','controls','webPublishItems','tableParts','extLst']
SP = ['tabColor','outlinePr','pageSetUpPr']
WB = ['fileVersion','fileSharing','workbookPr','workbookProtection','bookViews','sheets','functionGroups','externalReferences','definedNames','calcPr','oleSize',
      'customWorkbookViews','pivotCaches','smartTagPr','smartTagTypes','webPublishing','fileRecoveryPr','webPublishObjects','extLst']
def top_children(xml, root):
    body = xml[xml.index('<' + root):]; body = body[body.index('>') + 1:]
    out, depth, i = [], 0, 0
    for m in re.finditer(r'<(/?)([A-Za-z0-9_:]+)([^>]*?)(/?)>', body):
        close, name, _, selfc = m.group(1), m.group(2), m.group(3), m.group(4)
        if name.startswith('?'): continue
        if close: depth -= 1; continue
        if depth == 0: out.append(name.split(':')[-1])
        if not selfc: depth += 1
    return out
def check(seq, names, where):
    bad = []; last = -1
    for n in names:
        if n not in seq: continue
        k = seq.index(n)
        if k < last: bad.append(f'{where}: <{n}> after <{seq[last]}>')
        last = max(last, k)
    return bad
z = zipfile.ZipFile(sys.argv[1]); problems = []
wbx = z.read('xl/workbook.xml').decode(); problems += check(WB, top_children(wbx, 'workbook'), 'workbook.xml')
names = dict(re.findall(r'<sheet [^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"', wbx))
for n in sorted(z.namelist()):
    if re.match(r'xl/worksheets/sheet\d+\.xml$', n):
        x = z.read(n).decode(); kids = top_children(x, 'worksheet'); problems += check(WS, kids, n)
        m = re.search(r'<sheetPr[^>]*>(.*?)</sheetPr>', x)
        if m: problems += check(SP, [t for t in re.findall(r'<([A-Za-z]+)', m.group(1))], n + ' sheetPr')
print('\n'.join(problems) if problems else 'OK – element order valid in all parts')
