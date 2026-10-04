/* Online albums. Legacy browser data is retained, never silently uploaded or deleted. */
(function () {
  const categories = ['단체사진', '수상사진', '경기사진', '기타'];
  let cleanup = () => {};
  function element(tag, text, attributes = {}) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }
  function mount(root, meet) {
    cleanup();
    let active = true, urls = [], generation = 0;
    cleanup = () => { active = false; urls.forEach(URL.revokeObjectURL); urls = []; };
    root.innerHTML = `<section class="card event-gallery">
      <h2>대회 사진</h2><p class="muted">단체사진, 수상사진, 경기의 순간을 모아 보세요.</p>
      <p class="gallery-notice">온라인 서버 연결 후 사진을 보관합니다. 삭제한 사진은 휴지통에서 복구할 수 있습니다. 서버 연결 전에는 저장할 수 없습니다. 별도 백업 설정도 필요합니다.</p>
      <form class="gallery-form">
        <label>사진 종류<select name="category">${categories.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label>사진 설명 (선택)<input name="caption" maxlength="100" placeholder="예: 초등부 시상식"></label>
        <label>사진 선택<input name="files" type="file" accept="image/jpeg,image/png,image/webp" multiple required></label>
        <p class="muted">JPG·PNG·WebP · 장당 최대 15MB · 한 번에 20장. 인물 사진은 당사자 동의를 확인해 주세요.</p>
        <button class="btn primary" type="submit">선택한 사진 등록</button>
      </form>
      <p class="gallery-message" role="status" aria-live="polite"></p>
      <label class="gallery-filter">사진 모아보기<select>${['전체', ...categories, '휴지통'].map(c => `<option>${c}</option>`).join('')}</select></label>
      <div class="event-photo-grid"></div>
    </section>`;
    const form = root.querySelector('form');
    const message = root.querySelector('.gallery-message');
    const filter = root.querySelector('.gallery-filter select');
    const grid = root.querySelector('.event-photo-grid');
    async function refresh() {
      const version = ++generation;
      try {
        const rows = await window.GalleryCloud.list();
        if (!active || version !== generation) return;
        urls.forEach(URL.revokeObjectURL); urls = [];
        grid.replaceChildren();
        const visible = rows.filter(r => filter.value === '휴지통' ? !!r.deleted_at : !r.deleted_at && (filter.value === '전체' || r.category === filter.value)).sort((a,b) => b.created - a.created);
        if (!visible.length) grid.append(element('p', '등록된 사진이 없습니다. 위에서 사진을 선택해 등록해 주세요.', {class: 'muted'}));
        for (const row of visible) {
          const url = await window.GalleryCloud.url(row);
          if (!active || version !== generation) return;
          const card = element('article', '', {class: 'event-photo-card'});
          const link = element('a', '', {href: url, target: '_blank', rel: 'noopener', 'aria-label': `${row.caption || row.name} 크게 보기`});
          link.append(element('img', '', {src: url, alt: row.caption || row.name, loading: 'lazy'}));
          card.append(link, element('span', row.category, {class: 'badge'}), element('h3', row.caption || row.name));
          const actions = element('div', '', {class: 'gallery-actions'});
          actions.append(element('a', '다운로드', {href: url, download: row.name, class: 'btn'}));
          const remove = element('button', row.deleted_at ? '복구' : '휴지통으로', {type: 'button', class: 'btn', 'aria-label': `${row.caption || row.name} 삭제`});
          remove.onclick = async () => {
            if (!confirm(row.deleted_at ? '사진을 복구할까요?' : '휴지통으로 옮길까요? 원본은 서버에 유지됩니다.')) return;
            remove.disabled = true;
            try { await window.GalleryCloud.trash(row.id, !!row.deleted_at); if (active) { message.textContent = row.deleted_at ? '사진을 복구했습니다.' : '휴지통으로 옮겼습니다.'; await refresh(); } }
            catch { if (active) { message.textContent = '삭제하지 못했습니다. 다시 시도해 주세요.'; remove.disabled = false; } }
          };
          actions.append(remove); card.append(actions); grid.append(card);
        }
      } catch (error) { if (active) message.textContent = error.message || '온라인 사진 저장소에 연결하지 못했습니다.'; }
    }
    filter.onchange = refresh;
    form.onsubmit = async event => {
      event.preventDefault();
      const files = [...form.elements.files.files];
      if (!files.length || files.length > 20) { message.textContent = '사진을 1~20장 선택해 주세요.'; return; }
      if (files.some(f => !['image/jpeg','image/png','image/webp'].includes(f.type) || f.size > 15 * 1024 * 1024)) {
        message.textContent = 'JPG·PNG·WebP 사진만 가능하며, 각 파일은 15MB 이하여야 합니다.'; return;
      }
      const category = form.elements.category.value, caption = form.elements.caption.value.trim();
      const controls = [...form.elements]; controls.forEach(n => n.disabled = true);
      form.setAttribute('aria-busy', 'true');
      let saved = 0;
      try {
        for (const file of files) {
          if (!active) break;
          message.textContent = `사진 저장 중… ${saved} / ${files.length}`;
          const bitmap = await createImageBitmap(file); bitmap.close();
          await window.GalleryCloud.save({id: crypto.randomUUID(), category, caption, name: file.name, blob: file});
          saved++;
        }
        if (active) { message.textContent = `${saved}장을 저장했습니다.`; form.elements.files.value = ''; filter.value = '전체'; }
      } catch (error) { if (active) { message.textContent = `${saved}장 서버 저장됨. ${error.message || '저장 실패: 연결·권한을 확인해 주세요.'}`; form.elements.files.value = ''; } }
      finally { if (active) { controls.forEach(n => n.disabled = false); form.removeAttribute('aria-busy'); if (saved) await refresh(); } }
    };
    refresh();
  }
  window.EventGallery = { mount, dispose: () => cleanup() };
})();
