import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrlCredential } from '../src/util/redact-url-credential.mjs';

test('주소의 사용자 정보 가리기: 글 안 주소의 user:pass@·user@ 를 지우고 나머지 글은 그대로 둔다', () => {
  assert.equal(
    redactUrlCredential('Request cannot be constructed from a URL that includes credentials: http://user:secretpw@127.0.0.1:18803/tts'),
    'Request cannot be constructed from a URL that includes credentials: http://127.0.0.1:18803/tts',
  );
  assert.equal(redactUrlCredential('https://token@gpu.example.com/v1'), 'https://gpu.example.com/v1');
  assert.equal(redactUrlCredential('http://u:p@ss@host:8801'), 'http://host:8801', '비밀번호에 @ 가 그대로 들어가도 호스트 앞 @ 까지 지운다');
  assert.equal(redactUrlCredential('a http://a:x@h1/p · b ws://b:y@h2?q=1'), 'a http://h1/p · b ws://h2?q=1', '여러 주소');
  assert.equal(redactUrlCredential('"http://u:p@h/x"'), '"http://h/x"');
});

test('주소의 사용자 정보 가리기: 사용자 정보가 없는 글·주소 뒤의 @·글이 아닌 값은 바꾸지 않는다', () => {
  for (const text of [
    'fetch failed (ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:18802)',
    'http://127.0.0.1:8802/asr?mail=a@b.com',
    'http://host/path/@user',
    '담당 a@b.com 에게 알린다',
    'mailto:x@y.com',
    '',
  ]) assert.equal(redactUrlCredential(text), text);
  for (const value of [null, undefined, 42, true]) assert.equal(redactUrlCredential(value), value);
});
