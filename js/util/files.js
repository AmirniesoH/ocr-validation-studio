/**
 * Reading files and offering downloads.
 */
OVS.define('util/files', () => {
  'use strict';

  const readText = (file) => (file.text ? file.text() : new Response(file).text());
  const readArrayBuffer = (file) => (file.arrayBuffer ? file.arrayBuffer() : new Response(file).arrayBuffer());

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  return { readText, readArrayBuffer, downloadBlob };
});
