/** Cache immutable support code only; never capture settings, tokens or role resources. */
export function sharedPreparation<T>(prepare: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		if (!pending) {
			pending = Promise.resolve().then(prepare).catch(error => {
				pending = undefined;
				throw error;
			});
		}
		return pending;
	};
}

/** Defer optional work until the window can boot; failures must not block startup. */
export function schedulePreparation(prepare: () => Promise<unknown>, onError: (error: unknown) => void, delay = 1500): () => void {
	let disposed = false;
	const timer = setTimeout(() => {
		void Promise.resolve().then(() => disposed ? undefined : prepare()).catch(error => {
			if (!disposed) onError(error);
		});
	}, delay);
	timer.unref?.();
	return () => { disposed = true; clearTimeout(timer); };
}
