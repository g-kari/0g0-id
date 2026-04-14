<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	type Step = 'code' | 'login' | 'approve' | 'done' | 'denied';

	let step = $state<Step>('code');
	let codeLeft = $state('');
	let codeRight = $state('');
	let codeError = $state('');
	let verifying = $state(false);
	let approving = $state(false);

	let verifiedUserCode = '';
	let serviceName = $state('');
	let scopes = $state<string[]>([]);

	const errorMessages: Record<string, string> = {
		INVALID_CODE: '無効なコードです。もう一度確認してください。',
		CODE_EXPIRED: 'コードの有効期限が切れています。デバイスで新しいコードを取得してください。',
		CODE_ALREADY_USED: 'このコードは既に使用されています。',
		BAD_REQUEST: '入力内容に誤りがあります。'
	};

	onMount(() => {
		const codeParam = page.url.searchParams.get('code');
		if (codeParam) {
			const m = codeParam.toUpperCase().replace(/[^A-Z0-9-]/g, '').match(/^([A-Z0-9]{4})-?([A-Z0-9]{4})$/);
			if (m) { codeLeft = m[1]; codeRight = m[2]; }
		}
	});

	function buildLoginUrl(provider: string): string {
		const code = `${codeLeft}-${codeRight}`;
		return `/auth/login?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(`/device?code=${code}`)}`;
	}

	function onLeftInput(e: Event) {
		const val = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
		codeLeft = val;
		if (val.length >= 4) {
			document.getElementById('code-right')?.focus();
		}
	}

	function onLeftPaste(e: ClipboardEvent) {
		const pasted = e.clipboardData?.getData('text')?.trim().toUpperCase() ?? '';
		const m = pasted.match(/^([A-Z0-9]{4})-?([A-Z0-9]{4})$/);
		if (m) {
			e.preventDefault();
			codeLeft = m[1];
			codeRight = m[2];
			document.getElementById('code-right')?.focus();
		}
	}

	function onRightInput(e: Event) {
		codeRight = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
	}

	function onRightKeydown(e: KeyboardEvent) {
		if (e.key === 'Backspace' && codeRight === '') {
			document.getElementById('code-left')?.focus();
		}
	}

	async function verify() {
		if (codeLeft.length !== 4 || codeRight.length !== 4) {
			codeError = '8桁のコードを入力してください';
			return;
		}
		verifying = true;
		codeError = '';
		const userCode = `${codeLeft}-${codeRight}`;

		try {
			const res = await fetch('/api/device/verify', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_code: userCode })
			});
			const data = await res.json();
			if (res.status === 401) { step = 'login'; return; }
			if (data.error) {
				codeError = errorMessages[data.error.code] ?? data.error.message ?? '検証に失敗しました';
				return;
			}
			verifiedUserCode = userCode;
			serviceName = data.data.service_name ?? '不明なサービス';
			scopes = data.data.scopes ?? [];
			step = 'approve';
		} catch {
			codeError = '通信エラーが発生しました。再度お試しください。';
		} finally {
			verifying = false;
		}
	}

	async function approve(action: 'approve' | 'deny') {
		approving = true;
		try {
			const res = await fetch('/api/device/approve', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_code: verifiedUserCode, action })
			});
			const data = await res.json();
			if (data.error) { step = 'code'; codeError = data.error.message ?? '処理に失敗しました'; return; }
			step = action === 'approve' ? 'done' : 'denied';
		} catch {
			step = 'code';
			codeError = '通信エラーが発生しました。再度お試しください。';
		} finally {
			approving = false;
		}
	}
</script>

<svelte:head>
	<title>0g0 ID - デバイス認証</title>
	<meta name="description" content="デバイス認証コードを入力してください" />
</svelte:head>

<div class="min-h-screen flex items-center justify-center p-4">
	<div class="w-full max-w-sm">
		<div class="card">

			{#if step === 'code'}
				<h1 class="text-2xl font-bold mb-1">デバイス認証</h1>
				<p class="text-sm mb-6" style="color: var(--color-muted)">デバイスに表示されているコードを入力してください</p>
				{#if codeError}<div class="alert alert-error mb-4" role="alert">{codeError}</div>{/if}
				<form onsubmit={(e) => { e.preventDefault(); verify(); }} class="flex flex-col gap-4">
					<div class="flex items-center gap-2">
						<input id="code-left" type="text" value={codeLeft}
							oninput={onLeftInput} onpaste={onLeftPaste}
							maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck={false}
							placeholder="XXXX" required aria-label="コード前半4文字"
							class="flex-1 text-center text-lg font-mono tracking-widest px-3 py-2.5 rounded-lg border outline-none"
							style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)" />
						<span class="text-xl font-bold" style="color: var(--color-muted)" aria-hidden="true">-</span>
						<input id="code-right" type="text" value={codeRight}
							oninput={onRightInput} onkeydown={onRightKeydown}
							maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck={false}
							placeholder="XXXX" required aria-label="コード後半4文字"
							class="flex-1 text-center text-lg font-mono tracking-widest px-3 py-2.5 rounded-lg border outline-none"
							style="background: var(--color-surface); border-color: var(--color-border); color: var(--color-text)" />
					</div>
					<button type="submit" class="btn btn-primary btn-full" disabled={verifying}>
						{verifying ? '確認中...' : '確認'}
					</button>
				</form>

			{:else if step === 'login'}
				<h1 class="text-2xl font-bold mb-1">デバイス認証</h1>
				<p class="text-sm mb-6" style="color: var(--color-muted)">デバイス認証を続けるにはサインインが必要です</p>
				<div class="flex flex-col gap-3">
					<a href={buildLoginUrl('google')} class="btn btn-google">Googleでサインイン</a>
					<a href={buildLoginUrl('line')} class="btn btn-line">LINEでサインイン</a>
					<a href={buildLoginUrl('github')} class="btn btn-github">GitHubでサインイン</a>
				</div>

			{:else if step === 'approve'}
				<h1 class="text-2xl font-bold mb-1">デバイス認証</h1>
				<p class="text-sm mb-4" style="color: var(--color-muted)">
					<strong style="color: var(--color-text)">{serviceName}</strong> へのアクセスを許可しますか？
				</p>
				{#if scopes.length > 0}
					<p class="text-sm mb-2" style="color: var(--color-muted)">要求されているスコープ:</p>
					<div class="flex flex-wrap gap-1.5 mb-6">
						{#each scopes as scope}
							<span class="text-xs font-medium px-2.5 py-1 rounded-full"
								style="background: rgba(115,134,45,0.1); color: var(--color-accent)">{scope}</span>
						{/each}
					</div>
				{/if}
				<div class="flex gap-3 mt-4">
					<button class="btn btn-primary flex-1" onclick={() => approve('approve')} disabled={approving}>
						{approving ? '処理中...' : '許可する'}
					</button>
					<button class="btn btn-ghost flex-1" onclick={() => approve('deny')} disabled={approving}>
						拒否する
					</button>
				</div>

			{:else if step === 'done'}
				<div class="text-center">
					<div class="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
						style="background: rgba(45,122,58,0.1); color: var(--color-success)">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-6 h-6"><polyline points="20 6 9 17 4 12"/></svg>
					</div>
					<h1 class="text-2xl font-bold mb-2">認証完了</h1>
					<p class="text-sm" style="color: var(--color-muted)">デバイスに戻って操作を続けてください</p>
					<p class="text-sm mt-1" style="color: var(--color-muted)">このページは閉じて構いません</p>
				</div>

			{:else if step === 'denied'}
				<div class="text-center">
					<div class="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
						style="background: rgba(192,57,43,0.1); color: var(--color-danger)">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="w-6 h-6"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</div>
					<h1 class="text-2xl font-bold mb-2">認証を拒否しました</h1>
					<p class="text-sm" style="color: var(--color-muted)">デバイスへのアクセスは許可されませんでした</p>
					<p class="text-sm mt-1" style="color: var(--color-muted)">このページは閉じて構いません</p>
				</div>
			{/if}

		</div>
	</div>
</div>
