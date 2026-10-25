/** 有界并发，结果顺序与输入一致。 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	const result = new Array<R>(items.length);
	let next = 0;
 let failure:{reason:unknown}|undefined;
	const finished=await Promise.allSettled(
		Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
			while (next < items.length && !failure) {
				const index = next++;
				try{result[index] = await map(items[index]!);}
                catch(error){failure ??={reason:error};throw error;}
			}
		}),
	);
	const failed=finished.find((r):r is PromiseRejectedResult=>r.status==="rejected");
	if(failed)throw failed.reason;
	return result;
}
