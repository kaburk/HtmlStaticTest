/**
 * CuStaticAddonSiteSearch - client-side site search for static HTML.
 *
 * 静的サイト上で bc-search-index 由来の JSON インデックスを読み込み、
 * クライアントサイドで絞り込み検索を行う（依存ライブラリなし）。
 *
 * 動作:
 *  - 既存のテーマ検索フォーム（input[name="q"] を持つ form）を乗っ取り、
 *    送信を抑止して同一ページ内に結果を描画する。
 *  - ページの ?q= がある場合は読み込み時に自動検索する（検索結果ページ用）。
 *  - 結果は bc-search-index のテーマと同じ bs-search-result__* 構造で描画し、
 *    既存CSSを流用できるようにする。
 *
 * @copyright Copyright (c) catchup (https://catchup.co.jp/)
 * @license   MIT License
 */
(function () {
  'use strict';

  if (window.__cuStaticSearchInit) {
    return;
  }
  window.__cuStaticSearchInit = true;

  var currentScript = document.currentScript;

  /** アセット/JSON の配置ベースパス（例 "/cu_static_addon_site_search/"）。 */
  function resolveBase() {
    if (currentScript && currentScript.getAttribute('data-cu-static-search-base')) {
      return currentScript.getAttribute('data-cu-static-search-base');
    }
    if (currentScript && currentScript.src) {
      // .../cu_static_addon_site_search/js/cu-static-search.js -> .../cu_static_addon_site_search/
      return currentScript.src.replace(/js\/cu-static-search\.js.*$/, '');
    }
    return '/cu_static_addon_site_search/';
  }

  var BASE = resolveBase();
  var indexCache = null;
  var indexPromise = null;

  /** JSON を取得する。 */
  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        throw new Error('fetch failed: ' + url + ' (' + res.status + ')');
      }
      return res.json();
    });
  }

  /**
   * 現在サイトに対応するインデックスURLを決定する。
   * sites.json（[{id, alias}]）を見て、パスの先頭セグメントが alias に一致すれば
   * そのサイト別ファイル、なければ統合 search-index.json を使う。
   */
  function resolveIndexUrl() {
    return fetchJson(BASE + 'sites.json')
      .then(function (sites) {
        var path = location.pathname.replace(/^\//, '');
        var best = null;
        (sites || []).forEach(function (site) {
          var alias = (site.alias || '').replace(/^\/|\/$/g, '');
          if (alias && (path === alias || path.indexOf(alias + '/') === 0)) {
            if (!best || alias.length > best.alias.length) {
              best = { id: site.id, alias: alias };
            }
          }
        });
        if (best) {
          return BASE + 'search-index-' + best.id + '.json';
        }
        return BASE + 'search-index.json';
      })
      .catch(function () {
        // sites.json が無い場合は統合インデックスにフォールバック
        return BASE + 'search-index.json';
      });
  }

  /** インデックスを取得（キャッシュ）。 */
  function loadIndex() {
    if (indexCache) {
      return Promise.resolve(indexCache);
    }
    if (indexPromise) {
      return indexPromise;
    }
    indexPromise = resolveIndexUrl()
      .then(fetchJson)
      .then(function (data) {
        indexCache = Array.isArray(data) ? data : [];
        return indexCache;
      })
      .catch(function () {
        indexCache = [];
        return indexCache;
      });
    return indexPromise;
  }

  /** 検索キーワードを分解（半角/全角スペース区切りの AND）。 */
  function parseTerms(q) {
    return (q || '')
      .toLowerCase()
      .split(/[\s　]+/)
      .filter(function (t) {
        return t.length > 0;
      });
  }

  /** レコードが全キーワードを含むか（title + detail 対象）。 */
  function matches(row, terms) {
    var haystack = ((row.title || '') + ' ' + (row.detail || '')).toLowerCase();
    return terms.every(function (t) {
      return haystack.indexOf(t) !== -1;
    });
  }

  /** HTML エスケープ。 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 本文から最初のヒット位置周辺のスニペットを作る。 */
  function snippet(detail, terms, len) {
    var text = String(detail || '');
    if (!text) {
      return '';
    }
    var lower = text.toLowerCase();
    var pos = -1;
    for (var i = 0; i < terms.length; i++) {
      var p = lower.indexOf(terms[i]);
      if (p !== -1 && (pos === -1 || p < pos)) {
        pos = p;
      }
    }
    var start = pos > 30 ? pos - 30 : 0;
    var body = text.substr(start, len);
    if (start > 0) {
      body = '…' + body;
    }
    if (start + len < text.length) {
      body = body + '…';
    }
    return body;
  }

  /** キーワードを <mark> で強調（エスケープ後の文字列に対して行う）。 */
  function highlight(escapedText, terms) {
    var out = escapedText;
    terms.forEach(function (t) {
      if (!t) {
        return;
      }
      var re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      out = out.replace(re, '<mark>$1</mark>');
    });
    return out;
  }

  /** 結果を bs-search-result__* 構造で描画する。 */
  function render(container, rows, terms, limit) {
    if (!terms.length) {
      container.innerHTML =
        '<p class="bs-search-result__no-data">検索キーワードを入力してください。</p>';
      return;
    }
    if (!rows.length) {
      container.innerHTML =
        '<p class="bs-search-result__no-data">該当する結果が存在しませんでした。</p>';
      return;
    }

    var shown = rows.slice(0, limit);
    var html = '<p class="cu-search-count">' + rows.length + ' 件見つかりました。</p>';
    shown.forEach(function (row) {
      var title = highlight(esc(row.title), terms);
      var body = highlight(esc(snippet(row.detail, terms, 100)), terms);
      var url = esc(row.url);
      html +=
        '<div class="bs-search-result__item">' +
        '<h3 class="bs-search-result__item-head"><a href="' + url + '">' + title + '</a></h3>' +
        '<p class="bs-search-result__item-body">' + body + '</p>' +
        '<p class="bs-search-result__item-link"><small><a href="' + url + '">' + url + '</a></small></p>' +
        '</div>';
    });

    if (rows.length > shown.length) {
      html +=
        '<p class="cu-search-more"><button type="button" class="cu-search-more-btn">もっと見る</button></p>';
    }
    container.innerHTML = html;

    var moreBtn = container.querySelector('.cu-search-more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        render(container, rows, terms, limit + 20);
      });
    }
  }

  /** 検索を実行して描画する。 */
  function runSearch(container, q) {
    var terms = parseTerms(q);
    loadIndex().then(function (index) {
      var rows = terms.length
        ? index.filter(function (row) {
            return matches(row, terms);
          })
        : [];
      render(container, rows, terms, 20);
    });
  }

  /** フォーム直後（または指定 data 属性）に結果コンテナを用意する。 */
  function ensureResultContainer(form) {
    var explicit = document.querySelector('[data-cu-static-search-result]');
    if (explicit) {
      return explicit;
    }
    var existing = document.querySelector('.bs-search-result');
    if (existing) {
      return existing;
    }
    var container = document.createElement('section');
    container.className = 'bs-search-result';
    container.setAttribute('data-cu-static-search-result', '');
    form.parentNode.insertBefore(container, form.nextSibling);
    return container;
  }

  /** 既存の検索フォームを乗っ取る。 */
  function enhanceForm(form) {
    var input = form.querySelector('input[name="q"], input[type="search"]');
    if (!input) {
      return;
    }
    var container = ensureResultContainer(form);
    var timer = null;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runSearch(container, input.value);
    });

    // インクリメンタル検索（入力から少し待って実行）
    input.addEventListener('input', function () {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(function () {
        runSearch(container, input.value);
      }, 250);
    });
  }

  /** クエリ文字列から q を取り出す。 */
  function queryParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function init() {
    var forms = document.querySelectorAll('form');
    var enhanced = [];
    Array.prototype.forEach.call(forms, function (form) {
      if (form.querySelector('input[name="q"], input[type="search"]')) {
        enhanceForm(form);
        enhanced.push(form);
      }
    });

    // ?q= が指定されていれば読み込み時に自動検索（検索結果ページ・深リンク用）
    var q = queryParam('q');
    if (q) {
      var container =
        document.querySelector('[data-cu-static-search-result]') ||
        document.querySelector('.bs-search-result');
      if (!container && enhanced.length) {
        container = ensureResultContainer(enhanced[0]);
      }
      if (container) {
        // フォームがあれば入力欄へ値を反映
        var input = document.querySelector('form input[name="q"], form input[type="search"]');
        if (input) {
          input.value = q;
        }
        runSearch(container, q);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
