// ============================================================
// loadtest-squad-save.js
// اختبار حمل بـ k6 لمحاكاة "لحظة الديدلاين" — مئات المستخدمين
// بيحفظوا تشكيلتهم (POST /api/kv, action=set) في نفس الدقايق.
// ============================================================

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = 'https://mazareta.app';

const failedSaves = new Counter('failed_saves');
const saveDuration = new Trend('save_duration');

export const options = {
  scenarios: {
    deadline_rush: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: 10 },
        { duration: '40s', target: 1000 },
        { duration: '3m', target: 1000 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export default function () {
  const ownerToken = `loadtest-owner-${__VU}`;
  const key = `mazareta_squad:test-loadtest-${__VU}-${__ITER}`;

  const dummySquad = JSON.stringify({
    picks: Array.from({ length: 15 }, (_, i) => ({ element: 100 + i, position: i + 1 })),
    chip: null,
    savedAt: Date.now(),
  });

  const payload = JSON.stringify({
    action: 'set',
    key: key,
    value: dummySquad,
    owner: ownerToken,
  });

  const res = http.post(`${BASE_URL}/api/kv`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  saveDuration.add(res.timings.duration);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response has ok:true': (r) => {
      try {
        return JSON.parse(r.body).ok === true;
      } catch (e) {
        return false;
      }
    },
  });

  if (!ok) {
    failedSaves.add(1);
  }

  sleep(Math.random() * 1);
}
