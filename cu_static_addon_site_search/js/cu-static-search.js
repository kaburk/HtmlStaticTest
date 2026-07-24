/**
 * CuStaticAddonSiteSearch - client-side site search for static HTML.
 *
 * 静的書き出しされた検索結果ページ（実テーマ）上で、bc-search-index 由来の
 * JSON インデックスを読み込みクライアントサイド検索を行う（依存ライブラリなし）。
 *
 * 動作:
 *  - CuStatic 書き出し時に検索結果ページへ注入される（data-cu-static-search-page
 *    マーカー付き script）。マーカーが無いページでは何もしない。
 *  - URL の ?q=（キーワード）/ ?f=（フォルダ絞り込み）/ ?s=（サイトID）を解釈し、
 *    ロード時に必ず結果領域（.bs-search-result）と件数表示を描画し直す。
 *  - ページ上の検索フォームは submit を抑止して同一ページ内で即時描画し、
 *    pushState で URL を同期する（インクリメンタル検索対応）。
 *  - 結果は bc-search-index のテーマと同じ bs-search-result__* 構造で描画し、
 *    既存CSSを流用できるようにする。
 *
 * @copyright Copyright (c) catchup (https://catchup.co.jp/)
 * @license   MIT License
 */
(function () {
  'use strict';

  var script = document.querySelector('script[data-cu-static-search-page]');
  if (!script) {
    // 検索結果ページ以外では動作しない
    return;
  }
  if (window.__cuStaticSearchInit) {
    return;
  }
  window.__cuStaticSearchInit = true;

  /** アセット/JSON の配置ベースパス（例 "/cu_static_addon_site_search/"）。 */
  function resolveBase() {
    if (script.getAttribute('data-cu-static-search-base')) {
      return script.getAttribute('data-cu-static-search-base');
    }
    if (script.src) {
      // .../cu_static_addon_site_search/js/cu-static-search.js -> .../cu_static_addon_site_search/
      return script.src.replace(/js\/cu-static-search\.js.*$/, '');
    }
    return '/cu_static_addon_site_search/';
  }

  var BASE = resolveBase();
  var PAGE_SITE_ID = script.getAttribute('data-site-id') || '';
  var LIMIT_STEP = 20;
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
   * インデックスURLを決定する。優先順:
   *  1. URL の ?s=（サイトID）
   *  2. script の data-site-id（書き出し時のサイトID。常に埋め込まれる）
   *  3. メインサイト（site_id=1。サーバ側検索の既定値と同じ）
   */
  function resolveIndexUrl() {
    var s = new URLSearchParams(location.search).get('s') || PAGE_SITE_ID;
    if (!s || !/^\d+$/.test(s)) {
      s = '1';
    }
    return BASE + 'search-index-' + s + '.json';
  }

  /** インデックスを取得（キャッシュ）。 */
  function loadIndex() {
    if (indexCache) {
      return Promise.resolve(indexCache);
    }
    if (indexPromise) {
      return indexPromise;
    }
    indexPromise = fetchJson(resolveIndexUrl())
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
  function matchesTerms(row, terms) {
    var haystack = ((row.title || '') + ' ' + (row.detail || '')).toLowerCase();
    return terms.every(function (t) {
      return haystack.indexOf(t) !== -1;
    });
  }

  /** レコードがフォルダ（f= Contents.id）配下か。サーバ側の lft/rght 絞り込みと同義。 */
  function matchesFolder(row, folderId) {
    if (!folderId) {
      return true;
    }
    var ids = row.folder_ids || [];
    return ids.indexOf(folderId) !== -1;
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

  // --- ページ要素の特定 -------------------------------------------------

  var form =
    document.querySelector('.bs-search-form form') ||
    document.querySelector('form[action*="bc-search-index/search_indexes/search"]');
  var resultEl = document.querySelector('.bs-search-result');

  if (!resultEl) {
    // テーマが bc-front 既定構造でない場合は静かに無効化
    if (window.console && console.warn) {
      console.warn('[cu-static-search] .bs-search-result が見つからないため検索を無効化しました。');
    }
    return;
  }

  var inputQ = form ? form.querySelector('input[name="q"], input[type="search"]') : null;
  var selectF = form ? form.querySelector('select[name="f"]') : null;

  /** 件数表示エリア（list_counter 互換）。無ければ .bs-search-header 内に生成する。 */
  function counterEl() {
    var el = document.querySelector('.bs-search__result-text');
    if (el) {
      return el;
    }
    var header = document.querySelector('.bs-search-header');
    if (!header) {
      return null;
    }
    el = document.createElement('div');
    el.className = 'bs-search__result-text';
    header.insertBefore(el, header.firstChild);
    return el;
  }

  /** 表示件数リンク（list_num）はクリックで q が失われるため非表示にする。 */
  function hideListNum() {
    var el = document.querySelector('.bs-list-num');
    if (el) {
      el.style.display = 'none';
    }
  }

  // --- 描画 ---------------------------------------------------------------

  /** 件数表示を描画する（list_counter 互換の文言）。 */
  function renderCounter(q, total, shownCount) {
    var el = counterEl();
    if (!el) {
      return;
    }
    if (!q) {
      el.innerHTML = '';
      return;
    }
    var end = Math.min(shownCount, total);
    el.innerHTML =
      '<strong>' + esc(q) + '</strong> で検索した結果 ' +
      '<strong>' + (total ? 1 : 0) + '</strong>〜<strong>' + end + '</strong>件目 / ' +
      total + ' 件';
  }

  /** 結果を bs-search-result__* 構造で描画する。 */
  function renderResults(rows, terms, limit, q) {
    if (!terms.length) {
      renderCounter('', 0, 0);
      resultEl.innerHTML =
        '<p class="bs-search-result__no-data">検索キーワードを入力してください。</p>';
      return;
    }
    if (!rows.length) {
      renderCounter(q, 0, 0);
      resultEl.innerHTML =
        '<p class="bs-search-result__no-data">該当する結果が存在しませんでした。</p>';
      return;
    }

    var shown = rows.slice(0, limit);
    renderCounter(q, rows.length, shown.length);

    var html = '';
    shown.forEach(function (row) {
      var title = highlight(esc(row.title), terms);
      var body = highlight(esc(snippet(row.detail, terms, 100)), terms);
      var url = esc(row.url);
      var fullUrl = esc(location.origin + row.url);
      html +=
        '<div class="bs-search-result__item">' +
        '<h3 class="bs-search-result__item-head"><a href="' + url + '">' + title + '</a></h3>' +
        '<p class="bs-search-result__item-body">' + body + '</p>' +
        '<p class="bs-search-result__item-link"><small><a href="' + url + '">' + fullUrl + '</a></small></p>' +
        '</div>';
    });

    if (rows.length > shown.length) {
      html +=
        '<p class="cu-search-more"><button type="button" class="cu-search-more-btn">もっと見る</button></p>';
    }
    resultEl.innerHTML = html;

    var moreBtn = resultEl.querySelector('.cu-search-more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', function () {
        renderResults(rows, terms, limit + LIMIT_STEP, q);
      });
    }
  }

  /** 現在の条件（q, f）で検索して描画する。 */
  function runSearch(q, f) {
    var terms = parseTerms(q);
    var folderId = parseInt(f, 10) || 0;
    loadIndex().then(function (index) {
      var rows = terms.length
        ? index.filter(function (row) {
            return matchesTerms(row, terms) && matchesFolder(row, folderId);
          })
        : [];
      renderResults(rows, terms, LIMIT_STEP, q);
    });
  }

  // --- URL 同期 -------------------------------------------------------------

  /** フォームの現在値から検索し、URL を履歴へ反映する。 */
  function applyFromForm(pushHistory) {
    var q = inputQ ? inputQ.value : '';
    var f = selectF ? selectF.value : '';
    var params = new URLSearchParams(location.search);
    if (q) {
      params.set('q', q);
    } else {
      params.delete('q');
    }
    if (f) {
      params.set('f', f);
    } else {
      params.delete('f');
    }
    var qs = params.toString();
    var newUrl = location.pathname + (qs ? '?' + qs : '') + location.hash;
    if (pushHistory) {
      history.pushState(null, '', newUrl);
    } else {
      history.replaceState(null, '', newUrl);
    }
    runSearch(q, f);
  }

  /** URL の現在値をフォームへ同期して検索する（初期表示・popstate 用）。 */
  function applyFromUrl() {
    var params = new URLSearchParams(location.search);
    var q = params.get('q') || '';
    var f = params.get('f') || '';
    if (inputQ) {
      inputQ.value = q;
    }
    if (selectF) {
      selectF.value = f;
    }
    runSearch(q, f);
  }

  // --- イベント -------------------------------------------------------------

  function init() {
    hideListNum();

    if (form) {
      var timer = null;

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (timer) {
          clearTimeout(timer);
        }
        applyFromForm(true);
      });

      if (inputQ) {
        // インクリメンタル検索（入力から少し待って実行。履歴は汚さない）
        inputQ.addEventListener('input', function () {
          if (timer) {
            clearTimeout(timer);
          }
          timer = setTimeout(function () {
            applyFromForm(false);
          }, 250);
        });
      }

      if (selectF) {
        selectF.addEventListener('change', function () {
          applyFromForm(true);
        });
      }
    }

    window.addEventListener('popstate', function () {
      applyFromUrl();
    });

    // ロード時は必ず URL パラメータに基づいて描画し直す
    // （書き出し時の0件状態のHTMLを、qなし=「キーワードを入力」表示等で上書きする）
    applyFromUrl();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
