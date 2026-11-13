/**
 * Display names shared by several components.
 */
OVS.define('ui/labels', (require) => {
  'use strict';

  const { ext } = require('util/format');

  /** Short type tag shown next to a document name. */
  const docTag = (doc) => (doc.kind === 'pdf' ? 'PDF' : doc.kind === 'folder' ? 'DIR' : (ext(doc.name).toUpperCase() || 'IMG'));

  /** "letter.pdf · page 2", or just the document name for single-page documents. */
  const pageLabel = (doc, page) => (doc.pageIds.length > 1 ? doc.name + ' · ' + (doc.kind === 'pdf' ? 'page ' + page.pageNo : page.name) : doc.name);

  /** Colour of each page status (model/review.js pageStatus) in progress bars and dots. */
  const STATUS_COLOR = { complete: 'var(--ok)', progress: 'var(--accent)', new: 'var(--line2)', none: 'var(--line2)' };

  return { docTag, pageLabel, STATUS_COLOR };
});
