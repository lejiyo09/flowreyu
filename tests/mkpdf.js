const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fs = require('fs');
(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i++) {
    const land = i === 3;
    const page = pdf.addPage(land ? [842, 595] : [595, 842]);
    const { width, height } = page.getSize();
    page.drawText(`Test Page ${i + 1}`, { x: 50, y: height - 80, size: 32, font, color: rgb(0.1, 0.1, 0.4) });
    for (let y = height - 140; y > 60; y -= 28) page.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' + y, { x: 50, y, size: 11, font });
    page.drawRectangle({ x: 40, y: 40, width: width - 80, height: height - 80, borderColor: rgb(0.8, 0.2, 0.2), borderWidth: 1 });
    if (i === 4) page.setRotation(degrees(90));
  }
  fs.writeFileSync(process.argv[2], await pdf.save());
})();
