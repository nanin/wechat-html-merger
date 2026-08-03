(() => {
  'use strict';

  const manifest = window.__WECHAT_MANIFEST__;
  const timeline = document.querySelector('#timeline');
  const container = document.querySelector('#messages');
  const query = document.querySelector('#query');
  const count = document.querySelector('#count');
  const period = document.querySelector('#period');
  const meta = document.querySelector('#meta');
  const title = document.querySelector('#title');
  const lightbox = document.querySelector('#lightbox');
  const preview = document.querySelector('#lightbox-image');
  const PAGE_SIZE = 240;

  let selectedYear = 0;
  let selectedMonth = 0;
  let loadedFromPeriod = 0;
  let loadedThroughPeriod = 0;
  let mode = 'all';
  let visibleStart = 0;
  let visibleEnd = PAGE_SIZE;
  let zoom = 1;
  let scrollLoadPending = false;
  let scrollLoadSuppressed = false;
  let lastScrollTop = 0;
  let searchResults = null;
  let searchRequest = 0;
  let searchTimer = null;

  const loadedMonths = new Map();
  const loadingMonths = new Map();
  const monthEntries = Array.isArray(manifest && manifest.months) ? manifest.months : [];
  const monthByPeriod = new Map(
    monthEntries.map((entry) => [Number(entry.year) * 100 + Number(entry.month), entry])
  );
  const periodKeys = Array.from(monthByPeriod.keys()).sort((left, right) => left - right);

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  };

  const periodLabel = (key) => Math.floor(key / 100) + '年 ' + (key % 100) + '月';

  const isMedia = (message) => {
    const type = message.exportMediaType || (message.contentData && message.contentData.type);
    return type === 'image' || type === 'video';
  };

  const isFile = (message) => {
    const data = message.contentData || {};
    return Boolean(message.exportFileUrl) ||
      (data.type === 'share' && (String(data.typeVal) === '6' || String(data.typeVal) === '74')) ||
      message.type === '文件' || message.type === '文件发送中';
  };

  const isShare = (message) => {
    const type = message.contentData && message.contentData.type;
    return !isFile(message) &&
      (type === 'share' || type === 'miniProgram' || type === 'redPacket' || type === 'card');
  };

  const matchesMode = (message) => mode === 'all' ||
    (mode === 'media' && isMedia(message)) ||
    (mode === 'file' && isFile(message)) ||
    (mode === 'share' && isShare(message));

  const searchText = (message) => {
    const data = message.contentData || {};
    return [message.name, message.content, message.type, data.title, data.des, message.exportFileName]
      .filter(Boolean).join(' ').toLocaleLowerCase();
  };

  const formatBytes = (size) => {
    const value = Number(size || 0);
    if (!value) return '';
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
    return (value / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  };

  const httpUrl = (value) => {
    const url = String(value || '').trim();
    return url.startsWith('https://') || url.startsWith('http://') ? url : '';
  };

  function appendStructured(bubble, message) {
    const data = message.contentData;
    if (!data) return false;
    if (data.type === 'share') {
      const href = httpUrl(data.url);
      const card = make(href ? 'a' : 'div', 'structured-card');
      if (href) { card.href = href; card.target = '_blank'; card.rel = 'noreferrer'; }
      card.append(make('strong', '', data.title || '分享消息'));
      if (data.des) card.append(make('span', '', data.des));
      if (data.appname) card.append(make('small', '', data.appname));
      if (href) card.append(make('small', '', href));
      bubble.append(card);
      return true;
    }
    if (data.type === 'location') {
      const card = make('div', 'structured-card');
      card.append(make('strong', '', data.poiname || '位置'));
      if (data.label) card.append(make('span', '', data.label));
      if (Number.isFinite(data.lat) && Number.isFinite(data.lng)) {
        card.append(make('small', '', Number(data.lat).toFixed(6) + ', ' + Number(data.lng).toFixed(6)));
      }
      bubble.append(card);
      return true;
    }
    if (data.type === 'miniProgram' || data.type === 'redPacket' || data.type === 'card' || data.type === 'voip') {
      const card = make('div', 'structured-card');
      const primary = data.title || data.nickname || (data.type === 'voip' ? '通话记录' : '消息');
      const secondary = data.description || data.username || data.status || data.appName;
      card.append(make('strong', '', primary));
      if (secondary) card.append(make('span', '', secondary));
      bubble.append(card);
      return true;
    }
    return false;
  }

  function renderMessage(message) {
    const data = message.contentData || {};
    const system = data.type === 'system';
    const article = make('article', 'message' + (message.isSender ? ' sent' : '') + (system ? ' system' : ''));
    article.append(make('div', 'time', message.datetime || ''));
    const row = make('div', 'row');
    const bubble = make('div', 'bubble');
    if (!system && message.exportShowAvatar !== false) {
      const avatar = make('div', 'avatar');
      if (message.exportAvatarUrl) {
        const image = make('img'); image.src = message.exportAvatarUrl; image.alt = '';
        avatar.append(image);
      } else {
        avatar.textContent = String(message.name || (message.isSender ? '我' : '友')).slice(0, 1);
      }
      row.append(avatar);
    }
    if (!system) bubble.append(make('div', 'sender', message.name || (message.isSender ? '我' : '联系人')));

    let rendered = false;
    if (message.exportMediaUrl && (message.exportMediaType === 'image' || message.exportMediaType === 'sticker')) {
      const image = make('img', 'media-image');
      image.src = message.exportMediaUrl; image.alt = message.exportMediaType === 'sticker' ? '表情包' : '图片';
      bubble.append(image); rendered = true;
    } else if (message.exportMediaUrl && message.exportMediaType === 'video') {
      const video = make('video', 'media-image'); video.src = message.exportMediaUrl; video.controls = true; video.preload = 'metadata';
      bubble.append(video); rendered = true;
    }
    if (message.voiceDataUrl) {
      const wrap = make('div', 'audio-wrap');
      const audio = make('audio', 'audio'); audio.src = message.voiceDataUrl; audio.controls = true; audio.preload = 'metadata';
      wrap.append(audio); bubble.append(wrap); rendered = true;
    }
    if (message.exportFileUrl) {
      const file = make('a', 'file-card'); file.href = message.exportFileUrl; file.download = message.exportFileName || '';
      file.append(make('strong', '', message.exportFileName || data.title || '附件'));
      const size = formatBytes(message.exportFileSize);
      if (size) file.append(make('span', '', size));
      file.append(make('span', 'file-action', '下载文件'));
      bubble.append(file); rendered = true;
    } else if (data.type === 'quote') {
      const quote = make('div', 'quote-reference');
      quote.append(make('strong', '', data.quotedSender || '引用消息'));
      quote.append(make('span', '', data.quotedContent || '[引用消息]'));
      bubble.append(quote); rendered = true;
    } else if (!system && appendStructured(bubble, message)) {
      rendered = true;
    }
    if (message.exportMediaError) bubble.append(make('div', 'media-error', message.exportMediaError));

    const content = String(message.content || (system ? data.content || '' : '')).trim();
    const placeholder = new RegExp('^\\[(?:图片|视频|语音消息|表情包)\\]$').test(content);
    if (content && (!rendered || !placeholder) && !message.exportMediaError) {
      bubble.append(make('div', 'content', content));
      rendered = true;
    }
    if (!rendered && !message.exportMediaError) bubble.append(make('div', 'content', '[' + (message.type || '消息') + ']'));
    row.append(bubble); article.append(row);
    return article;
  }

  function showError(error) {
    console.error(error);
    count.textContent = '加载失败';
    container.replaceChildren(
      make('div', 'empty', '消息数据加载失败：' + (error instanceof Error ? error.message : String(error)))
    );
  }

  function loadMonth(periodKey) {
    if (loadedMonths.has(periodKey)) return Promise.resolve(loadedMonths.get(periodKey));
    if (loadingMonths.has(periodKey)) return loadingMonths.get(periodKey);
    const entry = monthByPeriod.get(periodKey);
    if (!entry) return Promise.resolve([]);
    const promise = new Promise((resolveLoad, rejectLoad) => {
      const script = document.createElement('script');
      script.src = entry.file;
      script.onload = () => {
        const chunks = window.__WECHAT_MONTH_CHUNKS__ || {};
        const messages = chunks[entry.key];
        delete chunks[entry.key];
        script.remove();
        if (!Array.isArray(messages)) {
          rejectLoad(new Error(entry.key + ' 的月份数据格式不正确'));
          return;
        }
        loadedMonths.set(periodKey, messages);
        resolveLoad(messages);
      };
      script.onerror = () => {
        script.remove();
        rejectLoad(new Error('无法加载 ' + entry.key + ' 的消息文件'));
      };
      document.head.append(script);
    }).finally(() => loadingMonths.delete(periodKey));
    loadingMonths.set(periodKey, promise);
    return promise;
  }

  function loadedRangeMessages() {
    const result = [];
    const fromIndex = periodKeys.indexOf(loadedFromPeriod);
    const throughIndex = periodKeys.indexOf(loadedThroughPeriod);
    if (fromIndex < 0 || throughIndex < fromIndex) return result;
    for (let index = fromIndex; index <= throughIndex; index += 1) {
      result.push(...(loadedMonths.get(periodKeys[index]) || []));
    }
    return result;
  }

  function filteredMessages() {
    const messages = searchResults || loadedRangeMessages();
    return messages.filter(matchesMode);
  }

  function clearSearch() {
    searchRequest += 1;
    searchResults = null;
    query.value = '';
    if (searchTimer) clearTimeout(searchTimer);
  }

  function renderTimeline() {
    timeline.replaceChildren();
    const earliestKey = periodKeys[0];
    const earliestButton = make(
      'button',
      'timeline-item all' + (loadedFromPeriod === earliestKey && loadedThroughPeriod === earliestKey ? ' active' : ''),
      '跳转到最早'
    );
    earliestButton.type = 'button';
    earliestButton.addEventListener('click', () => {
      clearSearch();
      selectPeriod(earliestKey).catch(showError);
    });
    timeline.append(earliestButton);

    const years = Array.from(new Set(monthEntries.map((entry) => Number(entry.year)))).sort((a, b) => a - b);
    for (const year of years) {
      const yearButton = make('button', 'timeline-item year' + (year === selectedYear ? ' active' : ''), year);
      yearButton.type = 'button';
      yearButton.addEventListener('click', () => {
        clearSearch();
        const months = monthEntries.filter((entry) => Number(entry.year) === year);
        const target = months.reduce((latest, entry) => Math.max(latest, year * 100 + Number(entry.month)), 0);
        selectPeriod(target).catch(showError);
      });
      timeline.append(yearButton);
      if (year === selectedYear) {
        const months = monthEntries
          .filter((entry) => Number(entry.year) === year)
          .sort((left, right) => Number(left.month) - Number(right.month));
        for (const entry of months) {
          const month = Number(entry.month);
          const monthButton = make(
            'button',
            'timeline-item month' + (month === selectedMonth ? ' active' : ''),
            month + '月'
          );
          monthButton.type = 'button';
          monthButton.addEventListener('click', () => {
            clearSearch();
            selectPeriod(year * 100 + month).catch(showError);
          });
          timeline.append(monthButton);
        }
      }
    }

    const latestKey = periodKeys[periodKeys.length - 1];
    const latestButton = make('button', 'timeline-item latest', '跳转到最新');
    latestButton.type = 'button';
    latestButton.addEventListener('click', () => {
      clearSearch();
      selectPeriod(latestKey, true).catch(showError);
    });
    timeline.append(latestButton);
  }

  async function selectPeriod(periodKey, scrollToEnd = false) {
    const entry = monthByPeriod.get(periodKey);
    if (!entry) return;
    await loadMonth(periodKey);
    selectedYear = Number(entry.year);
    selectedMonth = Number(entry.month);
    loadedFromPeriod = periodKey;
    loadedThroughPeriod = periodKey;
    const messages = filteredMessages();
    visibleEnd = scrollToEnd ? messages.length : Math.min(PAGE_SIZE, messages.length);
    visibleStart = scrollToEnd ? Math.max(0, visibleEnd - PAGE_SIZE) : 0;
    setScrollTop(0);
    renderTimeline();
    renderMessages({ scrollToEnd });
  }

  function hasNextPeriod() {
    const index = periodKeys.indexOf(loadedThroughPeriod);
    return index >= 0 && index < periodKeys.length - 1;
  }

  function hasPreviousPeriod() {
    const index = periodKeys.indexOf(loadedFromPeriod);
    return index > 0;
  }

  async function loadNextBatch() {
    let messages = filteredMessages();
    if (visibleEnd < messages.length) {
      visibleEnd = Math.min(messages.length, visibleEnd + PAGE_SIZE);
      renderMessages();
      return true;
    }
    if (searchResults) return false;
    const previousLength = messages.length;
    while (hasNextPeriod() && messages.length === previousLength) {
      const currentIndex = periodKeys.indexOf(loadedThroughPeriod);
      loadedThroughPeriod = periodKeys[currentIndex + 1];
      await loadMonth(loadedThroughPeriod);
      messages = filteredMessages();
    }
    if (messages.length === previousLength) return false;
    visibleEnd = Math.min(messages.length, visibleEnd + PAGE_SIZE);
    renderMessages();
    return true;
  }

  async function loadPreviousBatch() {
    let messages = filteredMessages();
    if (visibleStart > 0) {
      visibleStart = Math.max(0, visibleStart - PAGE_SIZE);
      renderMessages({ preservePrepend: true });
      return true;
    }
    if (searchResults) return false;
    const previousLength = messages.length;
    while (hasPreviousPeriod() && messages.length === previousLength) {
      const currentIndex = periodKeys.indexOf(loadedFromPeriod);
      loadedFromPeriod = periodKeys[currentIndex - 1];
      await loadMonth(loadedFromPeriod);
      messages = filteredMessages();
    }
    const prependedCount = messages.length - previousLength;
    if (prependedCount <= 0) return false;
    visibleStart = Math.max(0, prependedCount - PAGE_SIZE);
    visibleEnd = Math.min(messages.length, prependedCount + visibleEnd);
    renderMessages({ preservePrepend: true });
    return true;
  }

  function setScrollTop(value) {
    scrollLoadSuppressed = true;
    const previousBehavior = container.style.scrollBehavior;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = value;
    lastScrollTop = container.scrollTop;
    requestAnimationFrame(() => {
      container.style.scrollBehavior = previousBehavior;
      lastScrollTop = container.scrollTop;
      scrollLoadSuppressed = false;
    });
  }

  function renderMessages(options = {}) {
    const previousHeight = container.scrollHeight;
    const previousTop = container.scrollTop;
    if (options.preservePrepend || options.scrollToEnd) scrollLoadSuppressed = true;
    const messages = filteredMessages();
    visibleStart = Math.min(visibleStart, messages.length);
    visibleEnd = Math.max(visibleStart, Math.min(visibleEnd, messages.length));
    const shown = messages.slice(visibleStart, visibleEnd);
    container.replaceChildren(...shown.map(renderMessage));
    period.textContent = searchResults
      ? '全部时间搜索结果'
      : loadedFromPeriod === loadedThroughPeriod
        ? periodLabel(loadedFromPeriod)
        : periodLabel(loadedFromPeriod) + ' - ' + periodLabel(loadedThroughPeriod);
    count.textContent = '已显示 ' + shown.length.toLocaleString() + ' / ' + messages.length.toLocaleString() + ' 条';
    if (!messages.length) container.append(make('div', 'empty', '没有符合条件的消息'));
    if (visibleEnd < messages.length || (!searchResults && hasNextPeriod())) {
      const more = make('button', 'load-more', '加载更多'); more.type = 'button';
      more.addEventListener('click', () => loadNextBatch().catch(showError));
      container.append(more);
    }
    if (options.preservePrepend) {
      requestAnimationFrame(() => {
        setScrollTop(previousTop + Math.max(0, container.scrollHeight - previousHeight));
      });
    } else if (options.scrollToEnd) {
      requestAnimationFrame(() => setScrollTop(container.scrollHeight));
    } else {
      lastScrollTop = container.scrollTop;
    }
  }

  async function runSearch() {
    const term = query.value.trim().toLocaleLowerCase();
    const requestId = ++searchRequest;
    if (!term) {
      searchResults = null;
      visibleStart = 0;
      visibleEnd = PAGE_SIZE;
      renderMessages();
      return;
    }
    count.textContent = '正在搜索全部月份...';
    const results = [];
    for (let index = 0; index < periodKeys.length; index += 1) {
      const key = periodKeys[index];
      const messages = await loadMonth(key);
      if (requestId !== searchRequest) return;
      for (const message of messages) {
        if (searchText(message).includes(term)) results.push(message);
      }
      if (key < loadedFromPeriod || key > loadedThroughPeriod) loadedMonths.delete(key);
      count.textContent = '正在搜索 ' + (index + 1) + ' / ' + periodKeys.length + ' 个月...';
    }
    if (requestId !== searchRequest) return;
    searchResults = results;
    visibleStart = 0;
    visibleEnd = Math.min(PAGE_SIZE, results.length);
    setScrollTop(0);
    renderMessages();
  }

  function scheduleScrollLoad(direction) {
    if (scrollLoadPending) return;
    scrollLoadPending = true;
    requestAnimationFrame(() => {
      const action = direction === 'up' ? loadPreviousBatch() : loadNextBatch();
      action.catch(showError).finally(() => { scrollLoadPending = false; });
    });
  }

  if (!manifest || !monthEntries.length || !Number.isFinite(Number(manifest.totalMessages))) {
    container.append(make('div', 'empty', '消息清单未找到或格式不正确。'));
    return;
  }

  title.textContent = manifest.name || title.textContent;
  meta.textContent = Number(manifest.totalMessages).toLocaleString() + ' 条消息';

  query.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch().catch(showError), 220);
  });

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      mode = button.dataset.mode;
      document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
      visibleStart = 0;
      visibleEnd = PAGE_SIZE;
      setScrollTop(0);
      renderMessages();
    });
  });

  container.addEventListener('scroll', () => {
    const currentTop = container.scrollTop;
    const movingUp = currentTop < lastScrollTop;
    const nearTop = currentTop < 160;
    const nearBottom = container.scrollHeight - currentTop - container.clientHeight < 160;
    lastScrollTop = currentTop;
    if (scrollLoadSuppressed) return;
    if (movingUp && nearTop) scheduleScrollLoad('up');
    else if (!movingUp && nearBottom) scheduleScrollLoad('down');
  });

  container.addEventListener('wheel', (event) => {
    if (!scrollLoadSuppressed && event.deltaY < 0 && container.scrollTop <= 1) scheduleScrollLoad('up');
  }, { passive: true });

  container.addEventListener('click', (event) => {
    const image = event.target.closest('img.media-image');
    if (!image) return;
    preview.src = image.src; zoom = 1; preview.style.setProperty('--zoom', zoom); lightbox.classList.add('open');
  });

  const closeLightbox = () => {
    lightbox.classList.remove('open');
    preview.removeAttribute('src');
  };

  preview.addEventListener('wheel', (event) => {
    event.preventDefault(); zoom = Math.min(5, Math.max(.5, zoom + (event.deltaY < 0 ? .2 : -.2)));
    preview.style.setProperty('--zoom', zoom);
  }, { passive: false });
  preview.addEventListener('dblclick', () => { zoom = 1; preview.style.setProperty('--zoom', zoom); });
  lightbox.addEventListener('click', (event) => { if (event.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && lightbox.classList.contains('open')) closeLightbox();
  });

  selectPeriod(periodKeys[periodKeys.length - 1]).catch(showError);
})();
