// 실제 시간으로 조건이 될 때까지 기다린다(다른 프로세스가 뜨거나 죽는 것을 볼 때). 상한 안에 되면 true, 아니면 false.
export async function waitRealUntil(isDone, { limitMs = 3000, pollMs = 20 } = {}) {
  const startedAt = performance.now();
  while (!isDone()) {
    if (performance.now() - startedAt > limitMs) return false;
    await new Promise((resolve) => { setTimeout(resolve, pollMs); });
  }
  return true;
}
