// 동시에 concurrency 개까지만 돌린다. 결과는 입력 순서대로 돌려준다.
export async function mapWithConcurrency({ itemList, concurrency, run }) {
  const resultList = new Array(itemList.length);
  let cursor = 0;
  async function work() {
    while (cursor < itemList.length) {
      const index = cursor;
      cursor += 1;
      resultList[index] = await run(itemList[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, itemList.length));
  await Promise.all(Array.from({ length: workerCount }, work));
  return resultList;
}
