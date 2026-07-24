/**
 * CuStaticAddonMailForm - static-site mail form (client side).
 *
 * CuStatic が書き出した bc-mail のフォームページ上で動作する。依存ライブラリなし。
 *
 * 動作:
 *  - 書き出し済みの bc-mail 入力フォーム（action が /confirm で終わる form）を「乗っ取り」、
 *    通常の確認画面遷移を抑止する。
 *  - form-{id}.json（管理画面で定義されたフィールド・検証ルール）を読み、
 *    入力時にリアルタイム検証を行う。
 *  - endpoint.json の設定に従い、確認画面（DOM 差し替え）→ 送信 を行う。
 *  - 送信バックエンドは A: bc-mail 公開API / B: 外部サービス / C: 自前エンドポイント。
 *
 * 入力欄の name は bc-mail のフィールド名そのものなので、FormData(form) をそのまま
 * 各バックエンドへ送れる（案A の API はこの形式を期待する。file 型もそのまま添付される）。
 *
 * @copyright Copyright (c) catchup (https://catchup.co.jp/)
 * @license   MIT License
 */
(function () {
  'use strict';

  if (window.__cuStaticMailFormInit) {
    return;
  }
  window.__cuStaticMailFormInit = true;

  var script = document.currentScript;

  function attr(name, fallback) {
    if (script && script.getAttribute(name)) {
      return script.getAttribute(name);
    }
    return fallback;
  }

  var BASE = attr('data-cu-mailform-base', '/cu_static_addon_mail_form/');
  var FORM_ID = attr('data-cu-mailform-id', '');

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        throw new Error('fetch failed: ' + url + ' (' + res.status + ')');
      }
      return res.json();
    });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // フォーム検出
  // ---------------------------------------------------------------------------

  function findForm(def) {
    // 1) 確認ボタン（bc-mail 既定 id）を含む form
    var btn = document.getElementById('BtnMessageConfirm');
    if (btn && btn.form) {
      return btn.form;
    }
    // 2) action が confirm で終わる form
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      var action = forms[i].getAttribute('action') || '';
      if (/confirm\/?$/.test(action)) {
        return forms[i];
      }
    }
    // 3) 定義フィールド名を最も多く含む form
    var best = null;
    var bestScore = 0;
    for (var j = 0; j < forms.length; j++) {
      var score = 0;
      def.fields.forEach(function (f) {
        if (forms[j].querySelector('[name="' + cssEscape(f.name) + '"]')) {
          score++;
        }
      });
      if (score > bestScore) {
        bestScore = score;
        best = forms[j];
      }
    }
    return bestScore > 0 ? best : null;
  }

  function cssEscape(s) {
    return String(s).replace(/(["\\\]\[])/g, '\\$1');
  }

  // ---------------------------------------------------------------------------
  // 値の取得
  // ---------------------------------------------------------------------------

  function fieldInputs(form, name) {
    return Array.prototype.slice.call(
      form.querySelectorAll('[name="' + cssEscape(name) + '"], [name="' + cssEscape(name) + '[]"]')
    );
  }

  function getValue(form, field) {
    var inputs = fieldInputs(form, field.name);
    if (!inputs.length) {
      return '';
    }
    // bc-mail は radio / checkbox の先頭に同名の hidden input を出力するため、
    // inputs[0] の type ではなくフィールド定義の type で判定する
    var type = (inputs[0].type || '').toLowerCase();
    if (field.type === 'multi_check' || field.type === 'check' || type === 'checkbox') {
      var checked = inputs.filter(function (i) { return i.type === 'checkbox' && i.checked; }).map(function (i) { return i.value; });
      return checked.join(', ');
    }
    if (field.type === 'radio' || type === 'radio') {
      var sel = inputs.filter(function (i) { return i.type === 'radio' && i.checked; });
      return sel.length ? sel[0].value : '';
    }
    if (inputs[0].tagName === 'SELECT' && inputs[0].multiple) {
      return Array.prototype.slice.call(inputs[0].selectedOptions).map(function (o) { return o.value; }).join(', ');
    }
    if (type === 'file') {
      return inputs[0].files && inputs[0].files.length ? inputs[0].files[0].name : '';
    }
    return inputs[0].value || '';
  }

  // ---------------------------------------------------------------------------
  // リアルタイム検証（管理画面定義の再現）
  // ---------------------------------------------------------------------------

  var EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/;
  var TEL_RE = /^[0-9+\-()\s]+$/;

  function validateField(form, field) {
    // 定義にあるがページに存在しないフィールドは検証しない
    // （エラー表示先が無く「エラーなしで送信不能」になるのを防ぐ。サーバ側検証が最終防衛線）
    if (!fieldInputs(form, field.name).length) {
      return '';
    }
    var value = getValue(form, field).trim();

    if (field.required && value === '') {
      var verb = (field.type === 'select' || field.type === 'radio' || field.type === 'multi_check' || field.type === 'check')
        ? 'を選択してください。' : 'を入力してください。';
      return field.label + verb;
    }
    if (value === '') {
      return '';
    }
    if (field.type === 'email' && !EMAIL_RE.test(value)) {
      return 'メールアドレスの形式が正しくありません。';
    }
    if (field.type === 'number' && isNaN(Number(value))) {
      return '数値で入力してください。';
    }
    if (field.type === 'tel' && !TEL_RE.test(value)) {
      return '電話番号の形式が正しくありません。';
    }
    if (field.maxlength && value.length > field.maxlength) {
      return field.maxlength + '文字以内で入力してください。';
    }
    return '';
  }

  function validExList(field) {
    return String(field.validEx || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // group_valid が同じフィールドへのグループ検証（bc-mail の MailMessagesTable 準拠）。
  // group_field は「姓/名」等の表示上のグループ化であり検証には使わない。
  //  - VALID_EMAIL_CONFIRM: 同グループの値一致（メール再入力等）
  //  - VALID_GROUP_COMPLATE: グループ内は全部空か全部入力のどちらかのみ許可
  function validateGroups(form, def) {
    var errors = {};
    var groups = {};
    def.fields.forEach(function (f) {
      if (f.groupValid) {
        (groups[f.groupValid] = groups[f.groupValid] || []).push(f);
      }
    });
    Object.keys(groups).forEach(function (g) {
      var fields = groups[g];
      if (fields.length < 2) {
        return;
      }
      var values = fields.map(function (f) { return getValue(form, f).trim(); });

      var confirmFields = fields.filter(function (f) {
        return validExList(f).indexOf('VALID_EMAIL_CONFIRM') !== -1;
      });
      if (confirmFields.length) {
        var allFilled = values.every(function (v) { return v !== ''; });
        if (allFilled && values.some(function (v) { return v !== values[0]; })) {
          confirmFields.forEach(function (f) {
            errors[f.name] = '入力データが一致していません。';
          });
        }
      }

      var completeFields = fields.filter(function (f) {
        return validExList(f).indexOf('VALID_GROUP_COMPLATE') !== -1;
      });
      if (completeFields.length >= 2) {
        var cValues = completeFields.map(function (f) { return getValue(form, f).trim(); });
        var filled = cValues.filter(function (v) { return v !== ''; }).length;
        if (filled > 0 && filled < completeFields.length) {
          completeFields.forEach(function (f, i) {
            if (cValues[i] === '' && !errors[f.name]) {
              errors[f.name] = '入力データが不完全です。';
            }
          });
        }
      }
    });
    return errors;
  }

  function errorSpanId(name) {
    return 'cu-mf-error-' + name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function errorSpanFor(form, field) {
    var inputs = fieldInputs(form, field.name);
    if (!inputs.length) {
      return null;
    }
    var input = inputs[inputs.length - 1];
    var id = errorSpanId(field.name);
    var span = document.getElementById(id);
    if (!span) {
      span = document.createElement('span');
      span.id = id;
      span.className = 'cu-mf-error';
      var container = input.closest('td') || input.parentNode;
      container.appendChild(span);
    }
    return span;
  }

  function showFieldError(form, field, message) {
    var span = errorSpanFor(form, field);
    if (!span) {
      return;
    }
    span.textContent = message || '';
    span.style.display = message ? '' : 'none';
    var inputs = fieldInputs(form, field.name);
    inputs.forEach(function (i) {
      if (message) {
        i.classList.add('cu-mf-invalid');
      } else {
        i.classList.remove('cu-mf-invalid');
      }
    });
  }

  function validateAll(form, def) {
    var ok = true;
    var groupErrors = validateGroups(form, def);
    def.fields.forEach(function (field) {
      var message = validateField(form, field);
      if (!message && groupErrors[field.name]) {
        message = groupErrors[field.name];
      }
      showFieldError(form, field, message);
      if (message) {
        ok = false;
      }
    });
    return ok;
  }

  function bindRealtime(form, def) {
    def.fields.forEach(function (field) {
      var inputs = fieldInputs(form, field.name);
      inputs.forEach(function (input) {
        var handler = function () {
          var groupErrors = field.groupValid ? validateGroups(form, def) : {};
          var message = validateField(form, field) || groupErrors[field.name] || '';
          showFieldError(form, field, message);
          // 同じ検証グループでエラー表示中の相手フィールドも再評価する
          // （こちら側の修正で相手の一致/不完全エラーが解消されるため）
          if (field.groupValid) {
            def.fields.forEach(function (other) {
              if (other === field || other.groupValid !== field.groupValid) {
                return;
              }
              var span = document.getElementById(errorSpanId(other.name));
              if (!span || !span.textContent) {
                return;
              }
              showFieldError(form, other, validateField(form, other) || groupErrors[other.name] || '');
            });
          }
        };
        input.addEventListener('blur', handler);
        input.addEventListener('change', handler);
        input.addEventListener('input', handler);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 確認画面（DOM 差し替え）
  // ---------------------------------------------------------------------------

  // 確認画面の行データを組み立てる。bc-mail の入力画面と同じく、
  // group（group_field）が同じフィールドは1行にまとめ、見出しは先頭フィールドの
  // head（併記なしの素の見出し）、値は空欄を除いて連結する。
  function buildConfirmRows(form, def) {
    var rows = [];
    var groupIndex = {};
    def.fields
      .filter(function (f) { return !f.noSend && f.type !== 'hidden'; })
      .forEach(function (f) {
        var value = getValue(form, f);
        if (f.type === 'password') {
          value = value.replace(/./g, '●');
        }
        if (f.group) {
          if (groupIndex[f.group] === undefined) {
            groupIndex[f.group] = rows.length;
            rows.push({ label: f.head || f.label, values: [] });
          }
          if (value !== '') {
            rows[groupIndex[f.group]].values.push(value);
          }
        } else {
          rows.push({ label: f.label, values: value === '' ? [] : [value] });
        }
      });
    return rows;
  }

  function buildConfirmPanel(form, def, onSend, onBack) {
    var rows = buildConfirmRows(form, def)
      .map(function (r) {
        return '<tr><th>' + esc(r.label) + '</th><td>' + esc(r.values.join(' ')).replace(/\n/g, '<br>') + '</td></tr>';
      })
      .join('');

    var panel = document.createElement('div');
    panel.className = 'cu-mf-confirm';
    panel.innerHTML =
      '<h2 class="cu-mf-confirm__title">入力内容の確認</h2>' +
      '<table class="cu-mf-confirm__table">' + rows + '</table>' +
      '<div class="cu-mf-confirm__actions">' +
      '<button type="button" class="cu-mf-btn cu-mf-btn--back">修正する</button>' +
      '<button type="button" class="cu-mf-btn cu-mf-btn--send">送信する</button>' +
      '</div>';

    form.style.display = 'none';
    form.parentNode.insertBefore(panel, form.nextSibling);

    panel.querySelector('.cu-mf-btn--back').addEventListener('click', function () {
      panel.parentNode.removeChild(panel);
      form.style.display = '';
      onBack();
    });
    panel.querySelector('.cu-mf-btn--send').addEventListener('click', function () {
      panel.querySelector('.cu-mf-btn--send').disabled = true;
      onSend(function restore() {
        panel.querySelector('.cu-mf-btn--send').disabled = false;
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 送信バックエンド
  // ---------------------------------------------------------------------------

  function send(form, def, endpoint) {
    var backend = endpoint.backend;
    if (backend === 'external') {
      return sendExternal(form, def, endpoint.external);
    }
    if (backend === 'endpoint') {
      return sendUrl((endpoint.endpoint && endpoint.endpoint.url) || form.getAttribute('action'), form);
    }
    // 既定: bc-mail 公開API
    var base = endpoint.bcmailApiBase || '';
    // InflectedRoute のため controller はアンダースコア区切り（mail_messages）
    var url = base + '/baser/api/bc-mail/mail_messages/add/' + def.mailContentId + '.json';
    return fetch(url, { method: 'POST', body: new FormData(form), credentials: 'same-origin' })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, status: res.status, data: data };
        });
      });
  }

  function sendUrl(url, form) {
    return fetch(url, { method: 'POST', body: new FormData(form), credentials: 'same-origin' })
      .then(function (res) {
        return { ok: res.ok, status: res.status, data: {} };
      });
  }

  function sendExternal(form, def, ext) {
    if (ext.type === 'emailjs') {
      var params = {};
      def.fields.forEach(function (f) {
        if (!f.noSend) {
          params[f.name] = getValue(form, f);
        }
      });
      return fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: ext.serviceId,
          template_id: ext.templateId,
          user_id: ext.publicKey,
          template_params: params,
        }),
      }).then(function (res) {
        return { ok: res.ok, status: res.status, data: {} };
      });
    }

    // formspree / web3forms / 汎用: FormData を action へ POST
    var body = new FormData(form);
    if (ext.type === 'web3forms' && ext.publicKey) {
      body.append('access_key', ext.publicKey);
    }
    var action = ext.action || (ext.type === 'web3forms' ? 'https://api.web3forms.com/submit' : '');
    return fetch(action, { method: 'POST', body: body, headers: { Accept: 'application/json' } })
      .then(function (res) {
        return { ok: res.ok, status: res.status, data: {} };
      });
  }

  // API のフィールド別エラーを表示する（案A の errors 形式）
  function applyServerErrors(form, def, data) {
    if (!data || !data.errors) {
      return;
    }
    def.fields.forEach(function (field) {
      var errs = data.errors[field.name];
      if (errs) {
        var message = typeof errs === 'object' ? Object.keys(errs).map(function (k) { return errs[k]; }).join(' ') : String(errs);
        showFieldError(form, field, message);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 結果表示
  // ---------------------------------------------------------------------------

  function showThanks(form) {
    var confirmPanel = document.querySelector('.cu-mf-confirm');
    if (confirmPanel) {
      confirmPanel.parentNode.removeChild(confirmPanel);
    }
    var box = document.createElement('div');
    box.className = 'cu-mf-thanks';
    box.innerHTML = '<p>送信が完了しました。お問い合わせありがとうございました。</p>';
    form.style.display = 'none';
    form.parentNode.insertBefore(box, form.nextSibling);
  }

  function showSendError(form) {
    var box = document.querySelector('.cu-mf-send-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'cu-mf-send-error';
      form.parentNode.insertBefore(box, form);
    }
    box.textContent = '送信に失敗しました。時間をおいて再度お試しください。';
  }

  // ---------------------------------------------------------------------------
  // 初期化
  // ---------------------------------------------------------------------------

  function init(endpoint, def) {
    var form = findForm(def);
    if (!form) {
      return;
    }

    // ハニーポット（bot 誘引）
    if (endpoint.honeypot) {
      var hp = document.createElement('input');
      hp.type = 'text';
      hp.name = endpoint.honeypotField;
      hp.tabIndex = -1;
      hp.autocomplete = 'off';
      hp.setAttribute('aria-hidden', 'true');
      hp.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;';
      form.appendChild(hp);
    }

    // bc-mail の動的フロー用JS（mail_token.js 等）は書き出し時に除去されるが、
    // 古い書き出しやテーマ独自のスクリプトが送信ボタンを無効化している場合に備えて復帰させる
    var restoreSubmitButtons = function () {
      Array.prototype.slice.call(form.querySelectorAll('[type="submit"]')).forEach(function (btn) {
        btn.disabled = false;
        btn.style.pointerEvents = '';
      });
    };
    restoreSubmitButtons();

    bindRealtime(form, def);

    var doSend = function (restore) {
      // ハニーポットが埋まっていれば bot とみなし、成功したように見せて破棄
      if (endpoint.honeypot) {
        var hpInput = form.querySelector('[name="' + cssEscape(endpoint.honeypotField) + '"]');
        if (hpInput && hpInput.value) {
          showThanks(form);
          return;
        }
      }
      send(form, def, endpoint).then(function (result) {
        if (result.ok) {
          showThanks(form);
        } else {
          if (restore) { restore(); }
          applyServerErrors(form, def, result.data);
          form.style.display = '';
          var panel = document.querySelector('.cu-mf-confirm');
          if (panel) { panel.parentNode.removeChild(panel); }
          showSendError(form);
        }
      }).catch(function () {
        if (restore) { restore(); }
        showSendError(form);
      });
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // 他スクリプトがクリック時にボタンを無効化していても再試行できるようにする
      restoreSubmitButtons();
      if (!validateAll(form, def)) {
        // エラー項目が画面外にあると「押しても何も起きない」ように見えるため、
        // 最初のエラー項目までスクロールする
        var firstInvalid = form.querySelector('.cu-mf-invalid');
        if (firstInvalid && firstInvalid.scrollIntoView) {
          firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        return;
      }
      if (endpoint.useConfirm && def.useConfirm) {
        buildConfirmPanel(form, def, function (restore) { doSend(restore); }, function () {});
      } else {
        doSend();
      }
    });
  }

  Promise.all([
    fetchJson(BASE + 'endpoint.json'),
    fetchJson(BASE + 'form-' + FORM_ID + '.json'),
  ])
    .then(function (results) {
      init(results[0], results[1]);
    })
    .catch(function () {
      // 設定/定義が取得できない場合は何もしない（通常のフォームのまま）
    });
})();
