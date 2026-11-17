/* Runs in the extension background page, outside website Canvas protections. */
globalThis.ObscuraImagePDF = {
  async convert(files) {
    if (!Array.isArray(files) || !files.length || files.length > 10) throw new Error('每次支持 1 到 10 张图片');
    const document = await PDFLib.PDFDocument.create();
    let total = 0;
    for (const file of files) {
      if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.mime) || typeof file.data !== 'string' || file.data.length > 24 * 1024 * 1024) throw new Error('图片格式不支持或文件过大');
      let bytes = Uint8Array.from(atob(file.data), value => value.charCodeAt(0));
      total += bytes.length;
      if (!bytes.length || bytes.length > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error('单张图片最多 16 MB，每次最多 32 MB');
      if (file.mime === 'image/png' && bytes.length >= 24) {
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (header.getUint32(16) * header.getUint32(20) > 40000000) throw new Error('图片尺寸过大');
      }
      let image;
      if (file.mime === 'image/png') image = await document.embedPng(bytes);
      else if (file.mime === 'image/jpeg') image = await document.embedJpg(bytes);
      else {
        // Non-PNG/JPEG formats are decoded only in the extension's own origin.
        const bitmap = await createImageBitmap(new Blob([bytes], { type: file.mime }));
        try {
          if (bitmap.width * bitmap.height > 40000000) throw new Error('图片尺寸过大');
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
          image = await document.embedPng(bytes);
        } finally { bitmap.close(); }
      }
      const scale = Math.min(1, 14400 / Math.max(image.width, image.height));
      const width = image.width * scale, height = image.height * scale;
      document.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
    }
    const data = await document.saveAsBase64();
    if (data.length * 3 / 4 > 32 * 1024 * 1024) throw new Error('转换后的 PDF 超过 32 MB');
    return { name: files.length === 1 ? (files[0].name || '粘贴的图片').replace(/\.[^.]+$/, '') + '.pdf' : '粘贴的图片.pdf', mime: 'application/pdf', data };
  }
};
