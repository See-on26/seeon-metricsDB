import { checkKiwiSetup, buildTestSetupMessage } from '../src/product/kiwi-setup.mjs';

// npm test 의 pretest. 제품 의존성(kiwi-nlp)과 Kiwi 모델이 없으면 준비 명령을 찍고 1 로 끝낸다. 있으면 조용히 0.
const problemList = await checkKiwiSetup();
if (problemList.length) {
  console.error(buildTestSetupMessage(problemList));
  process.exit(1);
}
