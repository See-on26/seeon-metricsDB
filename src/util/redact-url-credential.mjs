// src/util/redact-url-credential.mjs

// scheme:// 바로 뒤에서 호스트 앞 마지막 @ 까지(경로·질의·공백·따옴표 전). 비밀번호에 @ 가 그대로 들어가도 호스트 앞까지 지운다.
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi;

// 글 안 주소의 사용자 정보(user:pass@, user@)를 지운다. 서비스 주소에 넣은 비밀번호가 undici 오류 문구 등에 실려
// 결과 JSON·manifest·로그로 나가지 않게 한다. 글이 아니거나 사용자 정보가 없으면 그대로 돌려준다.
export function redactUrlCredential(text) {
  if (typeof text !== 'string' || !text.includes('@')) return text;
  return text.replace(URL_CREDENTIAL_PATTERN, '$1');
}
