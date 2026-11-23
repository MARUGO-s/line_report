'use strict';

function loadSavedCredentials() {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    const email = saved && typeof saved.email === 'string' ? saved.email.trim() : '';
    if (!email) {
      localStorage.removeItem(CREDENTIAL_KEY);
      return null;
    }
    // 旧版はpasswordも保存していた。読み込み時に即座に削除し、メールだけへ移行する。
    if (Object.prototype.hasOwnProperty.call(saved, 'password')) {
      localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ email }));
    }
    return { email };
  } catch (_) {
    localStorage.removeItem(CREDENTIAL_KEY);
    return null;
  }
}

function saveCredentials(email) {
  try {
    const safeEmail = String(email || '').trim();
    if (!safeEmail) return clearCredentials();
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ email: safeEmail }));
  } catch (error) {
    console.error('Credential save error:', error);
  }
}

function clearCredentials() {
  localStorage.removeItem(CREDENTIAL_KEY);
}

function showSignup(e) {
  if (e) e.preventDefault();
  $('loginForm').classList.add('hidden');
  $('signupForm').classList.remove('hidden');
  hideNotice();
  $('signupEmailInput').value = $('emailInput').value.trim();
  $('signupRememberInput').checked = $('rememberInput').checked;
  $('signupEmailInput').focus();
}

function showLogin(e) {
  if (e) e.preventDefault();
  $('signupForm').classList.add('hidden');
  $('loginForm').classList.remove('hidden');
  $('emailInput').focus();
}

function formatAuthError(error, fallbackMessage) {
  const code = String(error && error.code ? error.code : '').trim().toLowerCase();
  const raw = String(error && error.message ? error.message : error || '').trim();
  if (
    code === 'weak_password' ||
    /weak and easy to guess|known to be weak|weak[_\s-]?password|pwned|compromised/i.test(raw)
  ) {
    return 'このパスワードは推測されやすいため使用できません。英大文字・小文字・数字・記号などを組み合わせた別のパスワードを設定してください';
  }
  if (/password should contain|at least one character of each|character classes/i.test(raw)) {
    return 'パスワードには英字・数字・記号などを組み合わせて設定してください';
  }
  if (/password should be at least|minimum.*password|password.*too short/i.test(raw)) {
    return 'パスワードが短すぎます。8文字以上で設定してください';
  }
  if (/password.*(too long|maximum|at most)/i.test(raw)) {
    return 'パスワードが長すぎます。72文字以内で設定してください';
  }
  if (
    code === 'user_already_exists' ||
    code === 'email_exists' ||
    /already registered|already been registered|already exists/i.test(raw)
  ) {
    return 'このメールアドレスは登録済みです。ログインしてください';
  }
  if (/confirmation email|sending email|error sending confirmation/i.test(raw)) {
    return '確認メールを送信できませんでした。管理者にご連絡ください';
  }
  if (
    code === 'email_address_invalid' ||
    /unable to validate email|invalid email|email address.*invalid|valid email/i.test(raw)
  ) {
    return '有効なメールアドレスを入力してください';
  }
  if (
    code === 'email_address_not_authorized' ||
    /email address.*not authorized/i.test(raw)
  ) {
    return 'このメールアドレスは登録が許可されていません。管理者にご連絡ください';
  }
  if (
    code === 'invalid_credentials' ||
    /invalid login/i.test(raw)
  ) {
    return 'メールアドレスまたはパスワードが違います';
  }
  if (
    code === 'email_not_confirmed' ||
    /email not confirmed/i.test(raw)
  ) {
    return 'メールアドレスの確認が完了していません。確認メールのリンクを開いてください';
  }
  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    /rate limit|too many requests|for security purposes.*after/i.test(raw)
  ) {
    return '短時間に操作が集中しました。しばらく時間をおいてからもう一度お試しください';
  }
  if (
    code === 'signup_disabled' ||
    /signup is disabled|signups not allowed/i.test(raw)
  ) {
    return '現在、新規登録は停止されています。管理者にご連絡ください';
  }
  if (code === 'user_banned' || /user.*banned/i.test(raw)) {
    return 'このアカウントは利用が制限されています。管理者にご連絡ください';
  }
  if (/failed to fetch|networkerror|load failed|network request failed|timed out|timeout|aborted/i.test(raw)) {
    return '通信に失敗しました。インターネット接続を確認して、もう一度お試しください';
  }
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(raw)) {
    return raw;
  }
  return fallbackMessage;
}

async function signup() {
  const email = $('signupEmailInput').value.trim();
  const password = $('signupPasswordInput').value;
  const confirm = $('signupPasswordConfirm').value;

  if (!email || !password) return showLoginError('メールアドレスとパスワードを入力してください');
  if (password.length < 8) return showLoginError('パスワードは8文字以上にしてください');
  if (password !== confirm) return showLoginError('確認用のパスワードが一致しません');

  $('signupBtn').disabled = true;
  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: authEmailRedirectUrl() }
    });

    if (error) {
      showLoginError(
        formatAuthError(
          error,
          '登録に失敗しました。入力内容をご確認のうえ、もう一度お試しください'
        )
      );
      return;
    }

    if (!data.session) {
      showLogin();
      showNotice('確認メールを送信しました。メール内のリンクを開くとM-talkに戻ります。戻ったらログインしてください。');
      $('emailInput').value = email;
      return;
    }

    $('signupPasswordInput').value = '';
    $('signupPasswordConfirm').value = '';
    pendingCredentials = { email, remember: $('signupRememberInput').checked };
    await afterSignIn();
  } catch (error) {
    console.error('Signup error:', error);
    showLoginError(
      formatAuthError(
        error,
        '登録に失敗しました。通信状況をご確認のうえ、もう一度お試しください'
      )
    );
  } finally {
    $('signupBtn').disabled = false;
  }
}

async function login() {
  const button = $('loginBtn');
  if (button.disabled) return;
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  if (!email || !password) return showLoginError('メールアドレスとパスワードを入力してください');

  const progress = $('loginProgress');
  button.disabled = true;
  button.textContent = '認証中…';
  progress.textContent = '認証しています。しばらくお待ちください。';
  progress.classList.remove('hidden');
  const slowTimer = setTimeout(() => {
    progress.textContent = '認証に時間がかかっています。再度押さずにお待ちください。画面が変わらない場合は再読み込みしてやり直してください。';
  }, 15000);
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showLoginError(
        formatAuthError(
          error,
          'ログインに失敗しました。入力内容をご確認のうえ、もう一度お試しください'
        )
      );
      return;
    }

    if ($('rememberInput').checked) {
      saveCredentials(email);
    } else {
      clearCredentials();
    }

    $('passwordInput').value = '';
    await afterSignIn();
  } catch (error) {
    console.error('Login error:', error);
    showLoginError(
      formatAuthError(
        error,
        'ログインに失敗しました。通信状況をご確認のうえ、もう一度お試しください'
      )
    );
  } finally {
    clearTimeout(slowTimer);
    progress.classList.add('hidden');
    button.textContent = 'ログイン';
    button.disabled = false;
  }
}
