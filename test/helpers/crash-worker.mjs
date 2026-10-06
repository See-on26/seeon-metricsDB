// 워커가 결과를 보내지 못하고 죽는 경우를 흉내 낸다(메모리 부족 SIGKILL 과 같은 종료 코드).
process.on('message', () => {
  console.log('곧 죽는다');
  setTimeout(() => process.exit(137), 20);
});
