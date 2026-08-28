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
      if (/already registered|already been registered/i.test(error.message)) {
        showLoginError('このメールアドレスは登録済みです。ログインしてください');
      } else if (/confirmation email|sending email/i.test(error.message)) {
        showLoginError('確認メールを送信できませんでした。管理者にご連絡ください');
      } else {
        showLoginError(`登録に失敗しました: ${error.message}`);
      }
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
    showLoginError(`登録に失敗しました: ${error.message || error}`);
  } finally {
    $('signupBtn').disabled = false;
  }
}

async function login() {
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  if (!email || !password) return showLoginError('メールアドレスとパスワードを入力してください');

  $('loginBtn').disabled = true;
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showLoginError(
        /invalid login/i.test(error.message)
          ? 'メールアドレスまたはパスワードが違います'
          : /email not confirmed/i.test(error.message)
            ? 'メールアドレスの確認が完了していません。確認メールのリンクを開いてください'
            : `ログインに失敗しました: ${error.message}`
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
    showLoginError(`ログインに失敗しました: ${error.message || error}`);
  } finally {
    $('loginBtn').disabled = false;
  }
}
