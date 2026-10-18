import JSZip from 'jszip';

/**
 * ExcelJS 4.4.0 writes a worksheet's <sheetPr> children as tabColor, pageSetUpPr, outlinePr,
 * but the SpreadsheetML schema requires tabColor, outlinePr, pageSetUpPr. Excel rejects the
 * whole sheet ("Replaced Part … XML error") when both "fit to page" and row/column grouping are
 * set — exactly the grouped report sheets. This puts <outlinePr> back before <pageSetUpPr> in
 * every worksheet of a finished workbook. Remove once ExcelJS renders the schema order itself.
 */
export async function fixSheetPrOrder(buffer: ArrayBuffer | Buffer | Uint8Array): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  for (const name of sheets) {
    const xml = await zip.file(name)!.async('string');
    const fixed = xml.replace(/<sheetPr\b[^>]*>[\s\S]*?<\/sheetPr>/, (block) => {
      const outline = /<outlinePr\b[^>]*\/>/.exec(block)?.[0];
      const pageSetup = /<pageSetUpPr\b[^>]*\/>/.exec(block)?.[0];
      if (!outline || !pageSetup || block.indexOf(outline) < block.indexOf(pageSetup)) return block;
      return block.replace(outline, '').replace(pageSetup, outline + pageSetup);
    });
    if (fixed !== xml) zip.file(name, fixed);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
