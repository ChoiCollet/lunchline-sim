/* ============================================================
   급식실 대기열 시뮬레이션 v4
   전략: A 초기선착순 / B 반별순번제 / C 현재(선착순 → 문앞에서 두 줄) /
        D 시차분산 제안 / E 순수 서펜타인(단일줄, 이론최적) / F 가상대기열(예약제)

   공간 모델(사용자 직접 제작 Archisketch 실측 평면도 + 화살표 동선 주석, 2026-08-29 + 현장 촬영 사진):
   계단실(2층) → 1-8복도(수직, 실측 8.5m) → 급식실 오른복도·왼복도 바닥을 따라 곧장 서쪽으로
     (문 앞은 들르지 않음, 실측 약 14.5m) → 학생 유도 라인(92㎡) 진입, 여기서부터 초록 유도선을
     "ㄷ"자로 이동: 바닥변(서쪽으로, 실측 11.8m) → 방 안쪽에서 꺾임 → 다시 상단변을 따라
     동쪽으로(같은 복도를 되돌아 나오는 구간까지 포함) → 급식실 입출구 왼쪽 벽의
     빨간색 "입장 대기선"에서 정지 → 대기선을 지나 조금 더 내려온 뒤 ㄷ자로 한 줄에서
     두 줄로 분기(분기 아랫부분에 세면대 배치) → 각 배식대로
     (배식대는 실제 급식실이 세로로 긴 구조라 위쪽 방향으로 계속 증설됨. 퇴장은 별도
     문·음수대(GOOTZ) 통로를 이용하며, 화면에는 "퇴장 완료" 수치로만 집계함)
   ============================================================ */

const STRATEGIES = {
  A: "A. 초기 선착순 (이동거리 불균등)",
  B: "B. 반별 순번제 (짝수반 왼쪽·홀수반 오른쪽)",
  C: "C. 현재 방식 (U자형 선착순 → 문앞에서 두 줄)",
  D: "D. 제안: 시차 분산 배정",
  E: "E. 순수 서펜타인 (단일줄, 이론 최적형)",
  F: "F. 가상대기열 (예약제)"
};
const CORRIDOR_STRATS = new Set(["A", "C", "D", "E", "F"]);

const STATION_NAMES_BASE = ["밥", "반찬1", "반찬2", "반찬3", "국"];
const STATION_TIME = [2, 5];
const HORIZON = 170;
const RELEASE_INTERVAL_B = 22;
const QUEUE_SPACING = 0.012; // 대기열에서 한 명이 차지하는 고정 간격(전체 대비 비율)
const CLASS_PAIRS_B = 6; // 12개 반 -> 6쌍
const ALL_CLASS_DONE_TICK_B = CLASS_PAIRS_B * RELEASE_INTERVAL_B;

// B 전략(반별 두 줄) 시각화에 쓰는 레인 좌표 — drawClassLineScene / addCheatFlash가 공유
const LANE_TOP = 20, LANE_BOTTOM = 260, LANE_X_L = 130, LANE_X_R = 300;

// ---------- 유틸 ----------
const rnd = () => Math.random();
const randInt = (min, max) => Math.floor(min + rnd() * (max - min + 1));
const randRange = (min, max) => min + rnd() * (max - min);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function gaussian(mean, std) {
  let u = 1 - rnd(), v = rnd();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function zoneLabel(t) {
  if (t < GREEN_START_T) return "계단실~복도(급식실 오른·왼복도 바닥, 문 앞은 안 거침)";
  if (t < GREEN_END_T) return "학생 유도 라인(초록선, ㄷ자 대기 구간)";
  if (t < FORK_T) return "입장 대기선 통과 후 ㄷ자 분기 전까지 이동";
  return "세면대 지나 배식대로(ㄷ자 분기 구간)";
}

// ---------- 경로 좌표(사용자가 직접 그린 구상도 기준 — 직각 경로) ----------
// 사용자 구상도: 계단실(우하단) → 왼쪽으로 이동 후 위로(회색, 미도색) → 학생 유도 라인
//   진입부터 초록색으로 바뀌어 ㄷ자(왼쪽 컬럼 위로 → 위쪽 변 → 오른쪽 컬럼 아래로)를 그리며
//   빨간 입장 대기선에서 끝남 → 대기 후 아래로 더 내려가다 두 갈래(짝수반 左·홀수반 右)로
//   갈라져 오른쪽 배식대 구역으로(모두 직각 이동, 곡선 없음)
// 감독 교사의 순찰 경로는 학생 동선과 별개로, ㄷ자 사이 빈 공간에서 위아래로만 왕복함
// (실제 GLB/평면도 실측 수치보다 사용자가 재구성한 이 동선 형태를 우선함)
const DESCEND_LEN = 80; // 입장 대기선을 지난 뒤, ㄷ자 분기가 시작되기 전까지 조금 더 내려오는 구간 길이
const PATH_POINTS = [
  { x: 560, y: 700, m: "계단실(대기열 시작)" },
  { x: 60,  y: 700, m: "왼쪽으로 이동" },
  { x: 60,  y: 380, m: "학생 유도 라인 진입 — 여기서부터 초록 유도선" },
  { x: 60,  y: 60,  m: "왼쪽 컬럼 위 끝 — ㄷ자 코너" },
  { x: 310, y: 60,  m: "위쪽 변 끝 — ㄷ자 반대쪽 코너" },
  { x: 310, y: 420, m: "오른쪽 컬럼 아래 — 빨간 입장 대기선" },
  { x: 310, y: 420 + DESCEND_LEN, m: "입장 대기선을 지나 조금 더 내려온 지점 — 여기서부터 ㄷ자로 배식대 분기" }
];
const GREEN_START_IDX = 2, GREEN_END_IDX = 5, RED_IDX = 5;

function buildPath(points) {
  const segLens = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    segLens.push(d);
    total += d;
  }
  return { points, segLens, total };
}
function pointAtT(path, t) {
  const target = clamp(t, 0, 1) * path.total;
  let acc = 0;
  for (let i = 0; i < path.segLens.length; i++) {
    const segLen = path.segLens[i];
    if (acc + segLen >= target || i === path.segLens.length - 1) {
      const localT = segLen > 0 ? clamp((target - acc) / segLen, 0, 1) : 0;
      const a = path.points[i], b = path.points[i + 1];
      return { x: a.x + (b.x - a.x) * localT, y: a.y + (b.y - a.y) * localT };
    }
    acc += segLen;
  }
  return path.points[path.points.length - 1];
}
function tAtIndex(path, idx) {
  let acc = 0;
  for (let i = 0; i < idx; i++) acc += path.segLens[i];
  return acc / path.total;
}

const MAIN_PATH = buildPath(PATH_POINTS);
function corridorPoint(t) { return pointAtT(MAIN_PATH, t); }

const GREEN_START_T = tAtIndex(MAIN_PATH, GREEN_START_IDX); // 학생 유도 라인(초록선) 시작
const GREEN_END_T = tAtIndex(MAIN_PATH, GREEN_END_IDX);     // 초록선 구간 끝 = 빨간 입장 대기선
const RED_T = GREEN_END_T;                                  // 빨간 입장 대기선(ㄷ자 분기 전, 경로 중간 지점)
const RED_MARK = corridorPoint(RED_T);

// 빨간 입장 대기선에서 잠시 멈춘 뒤, 곧바로 꺾이지 않고 조금 더 내려온 지점(경로의 끝, t=1)에서
// 비로소 ㄷ자로 두 줄로 갈라져 배식대로 들어감 (사용자 희망 구상도 반영: 대기선 → 소폭 하강 → ㄷ자 분기)
const FORK_BASE = corridorPoint(1);
const COUNTER_X = 440;           // 배식대 구역이 시작되는 x좌표(모든 배식대 공통, 한 줄로 위로만 증설)
const FORK_ARM = 60;             // ㄷ자 위/아래 팔의 길이
const FORK_L_Y = FORK_BASE.y - FORK_ARM; // ㄷ자 윗팔로 갈라져 들어가는 줄(짝수반)
const FORK_R_Y = FORK_BASE.y + FORK_ARM; // ㄷ자 아랫팔로 갈라져 들어가는 줄(홀수반) — 이 아랫팔에 세면대 배치
// 직각 전용 포크 경로: FORK_BASE에서 세로로 살짝 이동한 뒤 수평으로 꺾여 배식대 구역(COUNTER_X)으로.
// u는 0(빨간선 지점)~1(배식대 진입 지점) — 정적 안내선을 그릴 때나 대기열 끝부분을 그릴 때나 동일하게 사용.
function forkPoint(u, side) {
  u = clamp(u, 0, 1);
  const targetY = side === "L" ? FORK_L_Y : FORK_R_Y;
  const vertLen = Math.abs(targetY - FORK_BASE.y);
  const horizLen = COUNTER_X - FORK_BASE.x;
  const total = vertLen + horizLen;
  const d = u * total;
  if (d <= vertLen) {
    const dir = targetY > FORK_BASE.y ? 1 : -1;
    return { x: FORK_BASE.x, y: FORK_BASE.y + dir * d };
  }
  const localU = horizLen > 0 ? (d - vertLen) / horizLen : 0;
  return { x: FORK_BASE.x + horizLen * clamp(localU, 0, 1), y: targetY };
}
// 학생 대기열은 t=1(=FORK_BASE, 대기선을 지나 조금 내려온 지점)까지는 corridorPoint를 그대로
// 따라가다가, 그 지점을 넘어서면서 끊김 없이 ㄷ자 fork 구간으로 이어짐(t=1에서 corridorPoint와
// forkPoint(u=0)가 정확히 같은 좌표라 점프가 생기지 않음 — 맨 앞 학생이 초록선 끝까지 내려오지
// 않던 문제와, fork 구간에서만 간격이 벌어지던 문제를 함께 해결).
// fork 구간의 t 폭은 실제 물리적 분기 길이(세로+가로)를 본선 길이 비율로 환산해서 정하므로,
// 대기열 안에서의 간격과 배식대로 들어가는 구간의 간격이 동일하게 유지됨.
const FORK_T = 1;
const FORK_PHYS_LEN = FORK_ARM + (COUNTER_X - FORK_BASE.x);
const QUEUE_T_MAX = FORK_T + FORK_PHYS_LEN / MAIN_PATH.total;
function queuePoint(t, sideHint) {
  if (t <= FORK_T) return corridorPoint(t);
  const u = clamp((t - FORK_T) / (QUEUE_T_MAX - FORK_T), 0, 1);
  return forkPoint(u, sideHint);
}
// 세면대: ㄷ자의 "아랫팔"(FORK_R_Y) 위, 대기선에서 조금 내려온 지점부터 배식대 구역 사이에 배치
const SINK_L = { x: FORK_BASE.x + 40, y: FORK_R_Y };
const SINK_R = { x: FORK_BASE.x + 90, y: FORK_R_Y };

// 배식대: L/R로 좌우 분리하지 않고 한 컬럼(같은 x=COUNTER_X)에서 위로만 계속 증설됨(2x2 금지)
const COUNTER_BASE_Y = 500;   // 맨 아래(첫 번째) 배식대 줄의 y좌표
const COUNTER_ROW_SPACING = 84; // 위로 한 줄씩 늘어날 때 간격(배식대가 커진 만큼 소폭 확대)
const COUNTER_TOP_LABEL_Y = COUNTER_BASE_Y - 3 * COUNTER_ROW_SPACING - 22; // 4번째 줄 위 여백에 안내문구

// ---------- 감독 교사 순찰 경로(학생 동선과 별개, ㄷ자 사이 빈 공간에서 위아래로만 왕복) ----------
const PATROL_X = 185; // 왼쪽 컬럼(x60)과 오른쪽 컬럼(x310) 사이 중앙
const PATROL_Y_TOP = 70, PATROL_Y_BOTTOM = 400;
function patrolPoint(t) {
  return { x: PATROL_X, y: PATROL_Y_TOP + clamp(t, 0, 1) * (PATROL_Y_BOTTOM - PATROL_Y_TOP) };
}

// ---------- 패널(=하나의 독립 시뮬레이션) ----------
class LunchLineSim {
  constructor(root, label) {
    this.root = root;
    this.label = label;
    this.running = false;
    this.tick = 0;
    this.timer = null;
    this.buildDOM();
    this.bindControls();
    this.reset();
  }

  buildDOM() {
    this.root.innerHTML = `
      <div class="panel-head">
        <h2>${this.label}</h2>
        <span style="font-size:.68rem;color:#cfe6f5;">tick <span data-tick>0</span></span>
      </div>

      <div class="controls-bar">
        <fieldset>
          <legend>대기열 전략</legend>
          <div class="field">
            <select data-ctl="strategy">
              ${Object.entries(STRATEGIES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
            </select>
          </div>
        </fieldset>

        <fieldset>
          <legend>규모 · 배식대</legend>
          <div class="field"><label>학년 인원 <span data-out="pop"></span></label>
            <select data-ctl="population">
              <option value="345">2학년 · 345명(12반)</option>
              <option value="368">1학년 · 368명(12반)</option>
            </select></div>
          <div class="field"><label>배식대 수 <span data-out="counters"></span></label>
            <input type="range" data-ctl="counters" min="1" max="4" step="1" value="2"></div>
          <div class="check-row">
            <input type="checkbox" data-ctl="dessert" id="dessert-${this.label}">
            <label for="dessert-${this.label}">디저트 스테이션</label>
          </div>
        </fieldset>

        <fieldset>
          <legend>친구 무리 비율(%)</legend>
          <div class="field"><label>단독 <span data-out="g1"></span></label>
            <input type="range" data-ctl="g1" min="0" max="100" value="35"></div>
          <div class="field"><label>2~3명 <span data-out="g2"></span></label>
            <input type="range" data-ctl="g2" min="0" max="100" value="35"></div>
          <div class="field"><label>4~5명 <span data-out="g3"></span></label>
            <input type="range" data-ctl="g3" min="0" max="100" value="20"></div>
          <div class="field"><label>6~8명 <span data-out="g4"></span></label>
            <input type="range" data-ctl="g4" min="0" max="100" value="10"></div>
        </fieldset>

        <fieldset>
          <legend>자율배식(김치 등)</legend>
          <div class="check-row">
            <input type="checkbox" data-ctl="autoEnabled" id="auto-${this.label}" checked>
            <label for="auto-${this.label}">사용</label>
          </div>
          <div class="field"><label>참여율(%) <span data-out="autoRate"></span></label>
            <input type="range" data-ctl="autoRate" min="0" max="100" value="55"></div>
          <div class="field"><label>수용 인원 <span data-out="autoCap"></span></label>
            <input type="range" data-ctl="autoCap" min="1" max="8" value="3"></div>
        </fieldset>

        <fieldset>
          <legend>감독 · 새치기</legend>
          <div class="field"><label>감독 교사 수 <span data-out="teachers"></span></label>
            <select data-ctl="teachers">
              <option value="2">2명(문앞1+순찰1)</option>
              <option value="3">3명(문앞1+순찰2)</option>
            </select></div>
          <div class="field"><label>새치기 시도확률 <span data-out="cheatProb"></span></label>
            <input type="range" data-ctl="cheatProb" min="0" max="100" value="10"></div>
          <div class="field"><label>페널티(tick) <span data-out="penalty"></span></label>
            <input type="range" data-ctl="penalty" min="5" max="60" value="25"></div>
        </fieldset>

        <fieldset>
          <legend>실행</legend>
          <div class="field"><label>속도(tick/초) <span data-out="speed"></span></label>
            <input type="range" data-ctl="speed" min="1" max="20" value="8"></div>
          <div class="btn-row">
            <button class="btn" data-act="start">시작</button>
            <button class="btn secondary" data-act="pause">정지</button>
            <button class="btn danger" data-act="reset">초기화</button>
          </div>
        </fieldset>
      </div>

      <div class="stage">
        <canvas width="620" height="780"></canvas>
        <div class="stats">
          <div class="stat" title="대기열+배식중+자율배식중 전체 (Little's Law의 L)"><div class="k">시스템 내 인원(L)</div><div class="v" data-stat="L">0</div></div>
          <div class="stat"><div class="k">최대대기열(peak L)</div><div class="v" data-stat="peakL">0</div></div>
          <div class="stat"><div class="k">평균대기(W,tick)</div><div class="v" data-stat="W">0</div></div>
          <div class="stat"><div class="k">최대대기시간</div><div class="v" data-stat="maxW">0</div></div>
          <div class="stat"><div class="k">처리완료</div><div class="v" data-stat="served">0/0</div></div>
          <div class="stat"><div class="k">새치기 적발</div><div class="v" data-stat="caught">0</div></div>
          <div class="stat"><div class="k">새치기 성공</div><div class="v" data-stat="success">0</div></div>
          <div class="stat"><div class="k">새치기 지연(tick)</div><div class="v" data-stat="delay">0</div></div>
          <div class="stat"><div class="k">자율배식 정체</div><div class="v" data-stat="blocked">0</div></div>
          <div class="stat" title="리틀의 법칙 검증용: 시간에 따른 L의 평균"><div class="k">시간평균 L</div><div class="v" data-stat="avgL">0</div></div>
          <div class="stat" title="처리율(도착률=서비스율, 정상상태 가정)"><div class="k">처리율 λ(명/tick)</div><div class="v" data-stat="lambda">0</div></div>
          <div class="stat" title="λ×W ≈ 시간평균 L 이면 리틀의 법칙 성립"><div class="k">λ×W(리틀법칙 검증)</div><div class="v" data-stat="verify">0</div></div>
        </div>
        <div class="bottom-row">
          <div class="legend">
            <span><i class="swatch" style="background:#3f8fc4"></i>대기중</span>
            <span><i class="swatch" style="background:#e0a72e"></i>배식중</span>
            <span><i class="swatch" style="background:#8a63d2"></i>자율배식</span>
            <span><i class="swatch" style="background:#2f9e6e"></i>완료</span>
            <span><i class="swatch" style="background:#d64545"></i>적발</span>
            <span><i class="swatch" style="background:#f4b942;border:1px solid #b97e00"></i>친구대기(B)</span>
          </div>
          <div class="eventlog">
            <h3>새치기 이벤트 로그</h3>
            <ul data-eventlog></ul>
          </div>
        </div>
      </div>
    `;
    this.canvas = this.root.querySelector("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.ctlEls = {};
    this.root.querySelectorAll("[data-ctl]").forEach(el => this.ctlEls[el.dataset.ctl] = el);
    this.outEls = {};
    this.root.querySelectorAll("[data-out]").forEach(el => this.outEls[el.dataset.out] = el);
    this.statEls = {};
    this.root.querySelectorAll("[data-stat]").forEach(el => this.statEls[el.dataset.stat] = el);
    this.tickEl = this.root.querySelector("[data-tick]");
    this.logEl = this.root.querySelector("[data-eventlog]");
  }

  bindControls() {
    this.root.querySelectorAll("[data-ctl]").forEach(el => el.addEventListener("input", () => this.syncOutputs()));
    this.root.querySelector('[data-act="start"]').addEventListener("click", () => this.start());
    this.root.querySelector('[data-act="pause"]').addEventListener("click", () => this.pause());
    this.root.querySelector('[data-act="reset"]').addEventListener("click", () => this.reset());
    this.syncOutputs();
  }

  syncOutputs() {
    const c = this.readConfig();
    const map = { pop: `(${c.population}명)`, counters: `${c.counters}개`, g1: c.g1raw, g2: c.g2raw, g3: c.g3raw, g4: c.g4raw,
      autoRate: `${c.autoRate}%`, autoCap: `${c.autoCap}명`, teachers: `${c.teachers}명`, cheatProb: `${c.cheatProb}%`,
      penalty: `${c.penalty}`, speed: `${c.speed}` };
    Object.entries(map).forEach(([k, v]) => { if (this.outEls[k]) this.outEls[k].textContent = v; });
  }

  readConfig() {
    const g = k => Number(this.ctlEls[k].value);
    return {
      strategy: this.ctlEls.strategy.value,
      population: g("population"), counters: g("counters"), dessert: this.ctlEls.dessert.checked,
      g1raw: g("g1"), g2raw: g("g2"), g3raw: g("g3"), g4raw: g("g4"),
      autoEnabled: this.ctlEls.autoEnabled.checked, autoRate: g("autoRate"), autoCap: g("autoCap"),
      teachers: g("teachers"), cheatProb: g("cheatProb"), penalty: g("penalty"), speed: g("speed")
    };
  }

  buildPopulation(cfg) {
    const total = cfg.population;
    const weights = [cfg.g1raw, cfg.g2raw, cfg.g3raw, cfg.g4raw];
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const norm = weights.map(w => w / sum);
    const sizeRanges = [[1, 1], [2, 3], [4, 5], [6, 8]];
    const groups = [];
    let remaining = total, gid = 0;
    while (remaining > 0) {
      const r = rnd(); let acc = 0, chosen = 0;
      for (let i = 0; i < 4; i++) { acc += norm[i]; if (r <= acc) { chosen = i; break; } }
      let size = Math.min(randInt(sizeRanges[chosen][0], sizeRanges[chosen][1]), remaining);
      groups.push({ id: gid, size, classNum: (gid % 12) + 1 });
      gid++; remaining -= size;
    }
    return groups;
  }

  reset() {
    this.pause();
    const cfg = this.readConfig();
    this.cfg = cfg;
    this.tick = 0;

    const groups = this.buildPopulation(cfg);
    const students = [];
    let sid = 0;

    groups.forEach((grp, gi) => {
      let waitForFriends = false;
      if (cfg.strategy === "B" && grp.size >= 2) {
        const p = grp.size >= 4 ? 0.7 : 0.4;
        waitForFriends = rnd() < p;
      }
      let releaseTick;
      if (cfg.strategy === "B") {
        releaseTick = waitForFriends
          ? ALL_CLASS_DONE_TICK_B + randInt(0, 15)
          : (Math.ceil(grp.classNum / 2) - 1) * RELEASE_INTERVAL_B + randInt(0, 6);
      } else if (cfg.strategy === "A") {
        const far = rnd() < 0.4;
        const base = clamp(gaussian(35, 20), 0, HORIZON);
        releaseTick = Math.round(far ? clamp(base + randRange(30, 60), 0, HORIZON) : base);
        grp.isFar = far;
      } else if (cfg.strategy === "C" || cfg.strategy === "E") {
        releaseTick = Math.round(clamp(gaussian(35, 18), 0, HORIZON));
      } else if (cfg.strategy === "D") {
        releaseTick = Math.round(randRange(0, HORIZON));
      } else if (cfg.strategy === "F") {
        releaseTick = Math.round((gi / groups.length) * HORIZON + randRange(-2, 2));
      }

      for (let i = 0; i < grp.size; i++) {
        students.push({
          id: sid++, groupId: grp.id, groupSize: grp.size, classNum: grp.classNum,
          isFar: !!grp.isFar, waitForFriends,
          releaseTick: releaseTick + i, released: false,
          state: waitForFriends ? "friendwait" : "pending",
          counter: null, stationIdx: -1, stationRemain: 0,
          queueEnterTick: null, exitTick: null, penaltyUntil: null,
          willUseAutonomous: rnd() * 100 < cfg.autoRate,
          // 새치기: 입장 시점에 "이 학생이 평생 한 번이라도 새치기를 시도할지"를 미리 정함
          // (매 tick 확률을 계속 굴리지 않음 -> 전체 시도 횟수가 슬라이더 %와 실제로 일치)
          willCheat: rnd() * 100 < cfg.cheatProb,
          cheatAttempted: false,
          cheatDelay: randInt(3, 45)
        });
      }
    });
    this.students = students;
    this.totalPop = students.length;

    const leftCount = Math.ceil(cfg.counters / 2);
    const stationNames = cfg.dessert ? [...STATION_NAMES_BASE, "디저트"] : STATION_NAMES_BASE;
    this.stationNames = stationNames;
    this.counters = [];
    for (let i = 0; i < cfg.counters; i++) {
      this.counters.push({
        line: i < leftCount ? "L" : "R",
        stations: stationNames.map(() => ({ occupant: null, remain: 0, blocked: false }))
      });
    }

    this.corridor = [];            // A/C/D/E/F: 단일 U자형 대기열
    this.lines = { L: [], R: [] }; // B: 반별 두 줄
    this.friendWaitPool = students.filter(s => s.waitForFriends); // B: 친구 기다림 구역(시각화용)
    this.penaltyPool = [];
    this.autonomous = { occupants: [], cap: cfg.autoCap };
    this.cheatFlashes = [];
    this.eventLog = [];

    this.stats = { served: 0, waitSum: 0, maxWait: 0, caught: 0, success: 0, delayTicks: 0, blockedTicks: 0, Lintegral: 0, peakL: 0 };

    // 감독 교사: t=0(계단실쪽) ~ t=1(방풍실 앞)
    this.teacherA = { pos: RED_T, radius: 0.09 };   // 문앞: 급식실 입출구 빨간 입장 대기선 위치에 고정
    this.teacherB = { pos: 0.05, radius: 0.16, dir: 1, speed: 0.010, range: [0.0, cfg.teachers === 3 ? 0.55 : 0.9] };
    this.teacherC = cfg.teachers === 3 ? { pos: 0.55, radius: 0.15, dir: 1, speed: 0.009, range: [0.5, 0.95] } : null;
    this.reservationNext = 0; // F: 예약 다음 순번 표시용

    this.updateStatsUI();
    this.renderLog();
    this.draw();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const cfg = this.readConfig();
    const interval = Math.max(16, Math.round(1000 / cfg.speed));
    this.timer = setInterval(() => this.stepTick(), interval);
  }
  pause() { this.running = false; if (this.timer) clearInterval(this.timer); this.timer = null; }

  coverageAt(pos) {
    const teachers = [this.teacherA, this.teacherB, this.teacherC].filter(Boolean);
    let best = 0.05;
    teachers.forEach(t => {
      const d = Math.abs(pos - t.pos);
      let p;
      if (d < t.radius) p = 0.92;
      else if (d < t.radius * 2) p = 0.92 * (1 - (d - t.radius) / t.radius);
      else p = 0.05;
      best = Math.max(best, p);
    });
    return clamp(best, 0.03, 0.95);
  }

  posOfIndex(idx) {
    // 사람 한 명당 "고정 간격"만큼 뒤로 밀림 (대기열 전체 길이에 비례시키지 않음)
    // -> 줄이 짧을 때 억지로 넓게 퍼지거나, 길이 변화로 새치기 표시가 어긋나는 문제 방지
    // 맨 앞(idx=0)은 QUEUE_T_MAX(=배식대 진입 직전)까지 채워지므로, 초록선 끝까지 학생이 실제로 내려온다.
    return clamp(QUEUE_T_MAX - idx * QUEUE_SPACING, 0, QUEUE_T_MAX);
  }

  addCheatFlash(pos, caught) {
    let x, y;
    if (CORRIDOR_STRATS.has(this.cfg.strategy)) {
      const p = queuePoint(pos, "L");
      x = p.x; y = p.y;
    } else {
      // B: 왼쪽/오른쪽 줄 중 하나(둘 다 표시하기보다 임의로 왼쪽 레인에 표시)
      x = LANE_X_L; y = LANE_TOP + pos * (LANE_BOTTOM - LANE_TOP);
    }
    this.cheatFlashes.push({ x, y, until: this.tick + 15, caught });
  }

  pushLog(text, cls) {
    this.eventLog.unshift({ tick: this.tick, text, cls });
    if (this.eventLog.length > 5) this.eventLog.pop();
    this.renderLog();
  }
  renderLog() {
    if (!this.logEl) return;
    this.logEl.innerHTML = this.eventLog.map(e => `<li class="${e.cls}">tick ${e.tick} · ${e.text}</li>`).join("")
      || `<li style="color:#98a2b3">아직 발생한 새치기 없음</li>`;
  }

  stepTick() {
    this.tick++;
    const cfg = this.cfg;
    const corridorMode = CORRIDOR_STRATS.has(cfg.strategy);

    // 0) 교사 이동
    [this.teacherB, this.teacherC].forEach(t => {
      if (!t) return;
      t.pos += t.dir * t.speed;
      if (t.pos > t.range[1] || t.pos < t.range[0]) { t.dir *= -1; t.pos = clamp(t.pos, t.range[0], t.range[1]); }
    });

    // 1) 도착 처리
    this.students.forEach(s => {
      if (!s.released && s.releaseTick <= this.tick) {
        s.released = true;
        s.queueEnterTick = this.tick;
        if (s.waitForFriends) {
          this.friendWaitPool = this.friendWaitPool.filter(x => x.id !== s.id);
        }
        if (corridorMode) {
          s.state = "queueing";
          this.corridor.push(s);
        } else { // B
          s.state = "queueing";
          // 실제 안내판 기준: 짝수반(2,4,6,8,10,12번)→왼쪽(左), 홀수반(1,3,5,7,9,11번)→오른쪽(右)
          const line = s.waitForFriends
            ? (this.lines.L.length <= this.lines.R.length ? "L" : "R")
            : (s.classNum % 2 === 0 ? "L" : "R");
          s.line = line;
          this.lines[line].push(s);
        }
      }
    });

    // 2) 새치기 시도 (입장 시 정해진 "새치기 성향" 학생이 자기 대기시간 중 1회만 시도)
    const attemptCheat = (arr) => {
      for (let i = 1; i < arr.length; i++) {
        const s = arr[i];
        if (!s.willCheat || s.cheatAttempted) continue;
        if (this.tick - s.queueEnterTick < s.cheatDelay) continue;
        s.cheatAttempted = true; // 결과(적발/성공)와 무관하게 평생 1회만 시도
        const pos = this.posOfIndex(i);
        const zone = corridorMode ? zoneLabel(pos) : (s.line === "L" ? "왼쪽 줄" : "오른쪽 줄");
        const catchP = this.coverageAt(pos);
        if (rnd() < catchP) {
          arr.splice(i, 1);
          s.state = "penalty";
          s.penaltyUntil = this.tick + cfg.penalty;
          this.penaltyPool.push(s);
          this.stats.caught++;
          this.addCheatFlash(pos, true);
          this.pushLog(`${zone}에서 새치기 시도 → 감독 교사에게 적발, ${cfg.penalty}tick 페널티`, "caught");
        } else {
          const jump = randInt(1, 5);
          const newIdx = Math.max(0, i - jump);
          arr.splice(i, 1);
          arr.splice(newIdx, 0, s);
          this.stats.success++;
          this.stats.delayTicks += (i - newIdx);
          this.addCheatFlash(pos, false);
          this.pushLog(`${zone}에서 새치기 시도 → 미적발, ${i - newIdx}명 추월`, "success");
        }
        break;
      }
    };
    if (corridorMode) attemptCheat(this.corridor);
    else { attemptCheat(this.lines.L); attemptCheat(this.lines.R); }

    // 3) 페널티 종료 -> 맨 뒤 재진입
    this.penaltyPool = this.penaltyPool.filter(s => {
      if (s.penaltyUntil <= this.tick) {
        s.state = "queueing";
        if (corridorMode) this.corridor.push(s);
        else {
          const line = this.lines.L.length <= this.lines.R.length ? "L" : "R";
          s.line = line;
          this.lines[line].push(s);
        }
        return false;
      }
      return true;
    });

    // 4) 자율배식 처리
    this.autonomous.occupants = this.autonomous.occupants.filter(o => {
      o.remain--;
      if (o.remain <= 0) { this.finalizeStudent(o.student); return false; }
      return true;
    });

    // 5) 배식대 파이프라인
    this.counters.forEach(counter => {
      for (let idx = counter.stations.length - 1; idx >= 0; idx--) {
        const st = counter.stations[idx];
        if (!st.occupant) continue;
        if (st.remain > 0) { st.remain--; continue; }
        const isLast = idx === counter.stations.length - 1;
        if (isLast) {
          const s = st.occupant;
          if (s.willUseAutonomous && cfg.autoEnabled) {
            if (this.autonomous.occupants.length < this.autonomous.cap) {
              this.autonomous.occupants.push({ student: s, remain: randInt(4, 10) });
              s.state = "autonomous";
              st.occupant = null; st.blocked = false;
            } else { st.blocked = true; this.stats.blockedTicks++; }
          } else {
            this.finalizeStudent(s);
            st.occupant = null; st.blocked = false;
          }
        } else {
          const next = counter.stations[idx + 1];
          if (!next.occupant) {
            next.occupant = st.occupant;
            next.remain = randInt(STATION_TIME[0], STATION_TIME[1]);
            st.occupant = null; st.blocked = false;
          } else { st.blocked = true; }
        }
      }
    });

    // 6) 배식대 진입(첫 스테이션이 빈 곳에 다음 학생 배정)
    if (cfg.strategy === "E") {
      this.counters.forEach(counter => {
        const first = counter.stations[0];
        if (!first.occupant && this.corridor.length) {
          const s = this.corridor.shift();
          s.state = "serving"; s.counter = counter;
          first.occupant = s; first.remain = randInt(STATION_TIME[0], STATION_TIME[1]);
        }
      });
    } else if (cfg.strategy === "B") {
      this.counters.forEach(counter => {
        const first = counter.stations[0];
        if (!first.occupant) {
          const arr = this.lines[counter.line];
          const s = arr.shift();
          if (s) { s.state = "serving"; s.counter = counter; first.occupant = s; first.remain = randInt(STATION_TIME[0], STATION_TIME[1]); }
        }
      });
    } else {
      // A / C / D / F : 문 앞에서 "그때그때 더 짧은 쪽"으로 즉시 배정
      const freeCounters = this.counters.filter(c => !c.stations[0].occupant);
      while (this.corridor.length && freeCounters.length) {
        const occL = this.counters.filter(c => c.line === "L").reduce((a, c) => a + c.stations.filter(s => s.occupant).length, 0);
        const occR = this.counters.filter(c => c.line === "R").reduce((a, c) => a + c.stations.filter(s => s.occupant).length, 0);
        let preferSide = occL <= occR ? "L" : "R";
        let target = freeCounters.find(c => c.line === preferSide) || freeCounters[0];
        const s = this.corridor.shift();
        s.state = "serving"; s.counter = target;
        target.stations[0].occupant = s;
        target.stations[0].remain = randInt(STATION_TIME[0], STATION_TIME[1]);
        const fi = freeCounters.indexOf(target);
        freeCounters.splice(fi, 1);
      }
    }

    // 새치기 플래시 정리
    this.cheatFlashes = this.cheatFlashes.filter(f => f.until > this.tick);

    this.updateStatsUI();
    this.draw();

    if (this.stats.served >= this.totalPop) this.pause();
  }

  finalizeStudent(s) {
    s.state = "done";
    s.exitTick = this.tick;
    const wait = s.exitTick - s.queueEnterTick;
    this.stats.served++;
    this.stats.waitSum += wait;
    this.stats.maxWait = Math.max(this.stats.maxWait, wait);
  }

  updateStatsUI() {
    const inCounters = this.counters.reduce((a, c) => a + c.stations.filter(s => s.occupant).length, 0);
    const L = (this.corridor ? this.corridor.length : 0) + this.lines.L.length + this.lines.R.length
      + this.penaltyPool.length
      + inCounters + this.autonomous.occupants.length; // "시스템 내 전체 인원" = 대기 + 배식중 + 자율배식중
      // 친구 기다림 중인 학생(friendWaitPool)은 아직 실제로 줄에 서지 않은 상태라 L에서 제외
    this.stats.Lintegral += L;
    this.stats.peakL = Math.max(this.stats.peakL, L);
    const W = this.stats.served ? (this.stats.waitSum / this.stats.served).toFixed(1) : "0";
    const avgL = this.tick ? (this.stats.Lintegral / this.tick) : 0;
    const lambda = this.tick ? (this.stats.served / this.tick) : 0;
    const verify = lambda * parseFloat(W);
    this.statEls.L.textContent = L;
    this.statEls.W.textContent = W;
    this.statEls.maxW.textContent = this.stats.maxWait;
    this.statEls.peakL.textContent = this.stats.peakL;
    this.statEls.avgL.textContent = avgL.toFixed(2);
    this.statEls.lambda.textContent = lambda.toFixed(3);
    this.statEls.verify.textContent = verify.toFixed(2);
    this.statEls.served.textContent = `${this.stats.served}/${this.totalPop}`;
    this.statEls.caught.textContent = this.stats.caught;
    this.statEls.success.textContent = this.stats.success;
    this.statEls.delay.textContent = this.stats.delayTicks;
    this.statEls.blocked.textContent = this.stats.blockedTicks;
    if (this.tickEl) this.tickEl.textContent = this.tick;
  }

  // ---------- 렌더링 ----------
  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#eef2f6";
    ctx.fillRect(0, 0, W, H);

    const colors = { queueing: "#3f8fc4", serving: "#e0a72e", autonomous: "#8a63d2", done: "#2f9e6e", penalty: "#d64545", friendwait: "#f4b942" };
    const cfg = this.cfg;
    const corridorMode = CORRIDOR_STRATS.has(cfg.strategy);

    if (corridorMode) this.drawCorridorScene(ctx, colors);
    else this.drawClassLineScene(ctx, colors);

    this.drawCounters(ctx, colors, corridorMode);
    this.drawAutonomous(ctx, corridorMode);
    this.drawCheatFlashes(ctx);

    ctx.fillStyle = "#2f9e6e"; ctx.font = "12px sans-serif";
    ctx.fillText(`퇴장 완료: ${this.stats.served} / ${this.totalPop}`, 10, 348);
  }

  // 실측 사진 반영: 방풍실(전실) 안, 입구 문 지나자마자 손 씻는 세면대(별도 수전 2개)가 있음
  // (급식대로 가기 전 손씻기 — GOOTZ 음수대와는 다른, 퇴장용이 아닌 입장 직후 시설)
  drawSinkIcon(ctx, p) {
    ctx.strokeStyle = "#8fb4cf"; ctx.lineWidth = 1;
    ctx.strokeRect(p.x - 9, p.y - 6, 18, 12);
    ctx.beginPath(); ctx.fillStyle = "#cfe6f5";
    ctx.arc(p.x - 4, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(p.x + 4, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#5c86a3"; ctx.font = "8px sans-serif";
    ctx.fillText("세면대", p.x - 12, p.y + 16);
  }

  drawCorridorScene(ctx, colors) {
    const cfg = this.cfg;
    const strokeSeg = (t0, t1, style, width, steps = 20) => {
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.lineCap = "square";
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = t0 + (i / steps) * (t1 - t0);
        const p = corridorPoint(t);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    };

    // 1) 계단실 → 왼쪽으로 이동 → 위로(회색, 미도색) → 학생 유도 라인 진입 직전까지
    strokeSeg(0, GREEN_START_T, "#d7dde5", 15);
    // 2) 학생 유도 라인(초록선) — ㄷ자로 위로 → 가로 → 아래로, 빨간 입장 대기선까지
    strokeSeg(GREEN_START_T, GREEN_END_T, "#4caf7d", 15);

    // 빨간 입장 대기선 — 여기서 잠시 멈춤
    ctx.save();
    ctx.strokeStyle = "#d64545"; ctx.lineWidth = 5; ctx.lineCap = "square";
    ctx.beginPath();
    ctx.moveTo(RED_MARK.x - 26, RED_MARK.y);
    ctx.lineTo(RED_MARK.x + 26, RED_MARK.y);
    ctx.stroke();
    ctx.restore();

    // 3) 대기선을 지나 곧바로 꺾이지 않고 조금 더 내려온 뒤(회색) → 그 지점(FORK_BASE)에서
    //    비로소 ㄷ자로 두 줄로 갈라져 배식대 구역(COUNTER_X)으로
    strokeSeg(GREEN_END_T, 1, "#c9d2de", 15);
    ctx.strokeStyle = "#c9d2de"; ctx.lineWidth = 11; ctx.lineCap = "square";
    ["L", "R"].forEach(side => {
      ctx.beginPath();
      for (let i = 0; i <= 12; i++) {
        const u = i / 12;
        const p = forkPoint(u, side);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    });

    // 구간 라벨 — 실측 수치 표기 없이 구간명만 간단히 표시
    ctx.fillStyle = "#8a94a6"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("계단실", PATH_POINTS[0].x - 6, PATH_POINTS[0].y + 4);
    ctx.textAlign = "left";
    ctx.fillStyle = "#2f8a5c";
    ctx.fillText("학생 유도 라인(초록선)", PATH_POINTS[3].x + 8, PATH_POINTS[3].y - 8);
    ctx.fillStyle = "#c14a4a"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
    ctx.fillText("입장 대기선", RED_MARK.x - 32, RED_MARK.y + 4);
    ctx.textAlign = "center"; ctx.fillStyle = "#98a2b3"; ctx.font = "9px sans-serif";
    ctx.fillText("↑ 배식대 늘어나는 방향(2개→4개, 실제 급식실은 세로로 긴 구조)",
      COUNTER_X + 70, COUNTER_TOP_LABEL_Y);
    ctx.textAlign = "left";

    // 세면대 — 아랫라인(입장 동선) 부근에만 배치
    this.drawSinkIcon(ctx, SINK_L);
    this.drawSinkIcon(ctx, SINK_R);

    // 학생 점: FORK_T 이전은 단일 줄, 이후는 좌/우 포크 경로로 갈라져서 표시
    // (배정된 배식대 쪽(L/R)이 있으면 그쪽 포크로, 아직 없으면 인덱스 홀짝으로 임시 표시)
    const arr = this.corridor;
    const maxVisible = Math.floor((QUEUE_T_MAX - 0.02) / QUEUE_SPACING);
    const visible = arr.slice(0, maxVisible);
    visible.forEach((s, i) => {
      const t = this.posOfIndex(i);
      const sideHint = s.line || (i % 2 === 0 ? "L" : "R");
      const p = queuePoint(t, sideHint);
      ctx.beginPath();
      ctx.fillStyle = colors[s.state] || "#999";
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      if (cfg.strategy === "A" && s.isFar) {
        ctx.strokeStyle = "#e0761a"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
      }
    });
    if (arr.length > maxVisible) {
      ctx.fillStyle = "#667085"; ctx.font = "11px sans-serif";
      ctx.fillText(`+${arr.length - maxVisible}명 더 대기`, 10, 12);
    }

    // 페널티 격리
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, 610);

    // 교사
    this.drawTeacherOnCorridor(ctx, this.teacherA, "문앞", corridorPoint);
    this.drawTeacherOnCorridor(ctx, this.teacherB, "순찰", patrolPoint);
    if (this.teacherC) this.drawTeacherOnCorridor(ctx, this.teacherC, "순찰2", patrolPoint);

    // 전략별 배지
    if (cfg.strategy === "E") {
      ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
      ctx.fillText("※ 고정 두 줄 없음 — 비어있는 배식대로 즉시 배정(이론 최적형)", 10, 255);
    } else if (cfg.strategy === "D") {
      ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
      ctx.fillText("※ 시차 분산 공지 반영 — 도착이 시간대에 고르게 퍼짐", 10, 255);
    } else if (cfg.strategy === "F") {
      this.drawReservationBoard(ctx);
    }
  }

  // pointFn: 문앞 감독(teacherA)은 corridorPoint(학생 동선 위 고정), 순찰 교사(teacherB/C)는
  // patrolPoint(학생 동선과 분리된 ㄷ자 사이 빈 공간 왕복선)를 사용 — 서로 다른 경로임
  drawTeacherOnCorridor(ctx, t, label, pointFn) {
    const p = pointFn(t.pos);
    ctx.beginPath();
    ctx.fillStyle = "rgba(214,69,69,0.10)";
    ctx.arc(p.x, p.y, t.radius * 220, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#16243f";
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#16243f"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(label, p.x, p.y + 30);
    ctx.textAlign = "left";
  }

  drawReservationBoard(ctx) {
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`예약 현황판 — 총 ${this.totalPop}석 중 ${this.stats.served}석 이용 완료`, 10, 255);
    ctx.fillText(`(예약 시간대에 맞춰 손씻는 곳 앞으로만 잠깐 이동)`, 10, 268);
  }

  drawClassLineScene(ctx, colors) {
    const laneTop = 20, laneBottom = 260, dot = 8, gap = 3;
    const drawLane = (arr, x, label) => {
      const maxVisible = Math.floor((laneBottom - laneTop) / (dot + gap));
      const visible = arr.slice(0, maxVisible);
      visible.forEach((s, i) => {
        ctx.beginPath();
        ctx.fillStyle = colors[s.state] || "#999";
        ctx.arc(x, laneTop + i * (dot + gap), dot / 2, 0, Math.PI * 2);
        ctx.fill();
      });
      if (arr.length > maxVisible) {
        ctx.fillStyle = "#667085"; ctx.font = "11px sans-serif";
        ctx.fillText(`+${arr.length - maxVisible}명`, x - 20, laneBottom + 14);
      }
      ctx.fillStyle = "#334"; ctx.font = "12px sans-serif";
      ctx.fillText(label, x - 26, 12);
    };
    drawLane(this.lines.L, 130, "왼쪽 줄(짝수반)");
    drawLane(this.lines.R, 300, "오른쪽 줄(홀수반)");

    // 실제 안내판 문구 재현 (사진 확인: 짝수반 左 / 홀수반 右)
    ctx.fillStyle = "#8a94a6"; ctx.font = "9px sans-serif";
    ctx.fillText("짝수반 (2,4,6,8,10,12번) 左↑", 90, laneBottom + 30);
    ctx.fillText("홀수반 (1,3,5,7,9,11번) 右↑", 258, laneBottom + 30);

    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`새치기 격리 중: ${this.penaltyPool.length}명`, 10, 300);

    // 친구 기다림 구역 (넘치면 "+N개 그룹 더"로 표시, 배식대 영역과 겹치지 않게 높이 제한)
    const fx = 430, fy = 12, boxW = 330, boxH = 118;
    ctx.strokeStyle = "#e0a72e"; ctx.setLineDash([4, 3]);
    ctx.strokeRect(fx, fy, boxW, boxH);
    ctx.setLineDash([]);
    ctx.fillStyle = "#b97e00"; ctx.font = "10px sans-serif";
    ctx.fillText(`친구 기다림 구역 — 반이 다 지나갈 때까지 대기`, fx + 4, fy - 4);
    const groupsMap = {};
    this.friendWaitPool.forEach(s => { (groupsMap[s.groupId] ||= []).push(s); });
    const allGroups = Object.values(groupsMap);
    const cols = 6, rowH = 34, maxRows = Math.floor((boxH - 14) / rowH);
    const maxGroups = cols * maxRows;
    const shownGroups = allGroups.slice(0, maxGroups);
    shownGroups.forEach((members, gi) => {
      const col = gi % cols, row = Math.floor(gi / cols);
      const cx = fx + 18 + col * 52, cy = fy + 20 + row * rowH;
      members.slice(0, 8).forEach((m, mi) => {
        ctx.beginPath();
        ctx.fillStyle = colors.friendwait;
        ctx.arc(cx + (mi % 4) * 7, cy + Math.floor(mi / 4) * 7, 3, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.fillStyle = "#7a5300"; ctx.font = "9px sans-serif";
      ctx.fillText(`${members.length}명`, cx - 2, cy + 20);
    });
    if (!allGroups.length) {
      ctx.fillStyle = "#c9b083"; ctx.font = "10px sans-serif";
      ctx.fillText("(현재 대기 중인 무리 없음)", fx + 10, fy + 24);
    } else if (allGroups.length > maxGroups) {
      ctx.fillStyle = "#b97e00"; ctx.font = "9px sans-serif";
      ctx.fillText(`+${allGroups.length - maxGroups}개 그룹 더 대기 중`, fx + 8, fy + boxH - 4);
    }

    // 교사(두 줄 위를 함께 순찰한다고 가정, 같은 높이에 표시)
    const drawTeacherLane = (t, label) => {
      const y = laneTop + t.pos * (laneBottom - laneTop);
      [130, 300].forEach(x => {
        ctx.beginPath(); ctx.fillStyle = "rgba(214,69,69,0.10)";
        ctx.arc(x, y, t.radius * (laneBottom - laneTop), 0, Math.PI * 2); ctx.fill();
      });
      ctx.beginPath(); ctx.fillStyle = "#16243f"; ctx.arc(215, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#16243f"; ctx.font = "10px sans-serif"; ctx.fillText(label, 222, y + 3);
    };
    drawTeacherLane(this.teacherA, "문앞");
    drawTeacherLane(this.teacherB, "순찰");
    if (this.teacherC) drawTeacherLane(this.teacherC, "순찰2");
  }

  drawCounters(ctx, colors, corridorMode) {
    if (corridorMode) {
      // 세로형 레이아웃: L/R로 좌우 분리하지 않고, 하나의 컬럼(같은 x)에서 배식대가
      // 계속 "위로만" 증설되는 형태 (실제 급식실이 세로로 긴 구조이기 때문)
      // 기존(20x34)보다 비율(20:34)을 유지한 채 소폭 확대(24x41)
      const stationW = 24, counterH = 41;
      this.counters.forEach((c, i) => {
        const startX = COUNTER_X;
        const y = COUNTER_BASE_Y - i * COUNTER_ROW_SPACING;
        const labelSuffix = this.cfg.strategy === "E" ? "" : `(${c.line})`;
        ctx.fillStyle = "#334"; ctx.font = "10px sans-serif";
        ctx.fillText(`배식대${i + 1}${labelSuffix}`, startX, y - 6);
        c.stations.forEach((st, si) => {
          const x = startX + si * stationW;
          ctx.strokeStyle = "#c3cad4";
          ctx.strokeRect(x, y, stationW - 4, counterH);
          if (st.occupant) {
            ctx.fillStyle = st.blocked ? "#d64545" : (colors[st.occupant.state] || "#e0a72e");
            ctx.fillRect(x + 3, y + 3, stationW - 10, counterH - 6);
          }
          ctx.fillStyle = "#667085"; ctx.font = "7px sans-serif";
          ctx.fillText(this.stationNames[si], x, y + counterH + 9);
        });
      });
      return;
    }
    // B 전략(반별 두 줄)용 기존 가로 배치
    const counterH = 34;
    const counterTop = 150, stationW = 30, baseX = 430, rowGap = 84;
    let li = 0, ri = 0;
    this.counters.forEach((c) => {
      const totalW = c.stations.length * stationW;
      const row = c.line === "L" ? li++ : ri++;
      const startX = baseX + row * (totalW + 12);
      const y = counterTop + (c.line === "L" ? 0 : rowGap);
      const labelSuffix = this.cfg.strategy === "E" ? "" : `(${c.line})`;
      ctx.fillStyle = "#334"; ctx.font = "10px sans-serif";
      ctx.fillText(`배식대${this.counters.indexOf(c) + 1}${labelSuffix}`, startX, y - 6);
      c.stations.forEach((st, si) => {
        const x = startX + si * stationW;
        ctx.strokeStyle = "#c3cad4";
        ctx.strokeRect(x, y, stationW - 4, counterH);
        if (st.occupant) {
          ctx.fillStyle = st.blocked ? "#d64545" : (colors[st.occupant.state] || "#e0a72e");
          ctx.fillRect(x + 3, y + 3, stationW - 10, counterH - 6);
        }
        ctx.fillStyle = "#667085"; ctx.font = "8px sans-serif";
        ctx.fillText(this.stationNames[si], x + 1, y + counterH + 9);
      });
    });
  }

  drawAutonomous(ctx, corridorMode) {
    // corridorMode: 배식대1(맨 아래 줄, y=COUNTER_BASE_Y)의 스테이션 이름 라벨 바로 아래에 배치
    // (수용 인원 슬라이더를 크게 잡아도 캔버스 오른쪽 밖으로 넘치지 않도록 시작 x를 보정)
    const maxAutoX = this.canvas.width - this.autonomous.cap * 28 - 10;
    const autoX = corridorMode ? Math.min(COUNTER_X, maxAutoX) : 430;
    const autoY = corridorMode ? COUNTER_BASE_Y + 72 : 300;
    ctx.fillStyle = "#334"; ctx.font = "11px sans-serif";
    ctx.fillText(`자율배식(김치 등) — ${this.autonomous.occupants.length}/${this.autonomous.cap}`, autoX, autoY - 6);
    for (let i = 0; i < this.autonomous.cap; i++) {
      ctx.strokeStyle = "#c3cad4";
      ctx.strokeRect(autoX + i * 28, autoY, 22, 22);
      if (this.autonomous.occupants[i]) {
        ctx.fillStyle = "#8a63d2";
        ctx.fillRect(autoX + 3 + i * 28, autoY + 3, 16, 16);
      }
    }
  }

  drawCheatFlashes(ctx) {
    this.cheatFlashes.forEach(f => {
      const life = f.until - this.tick;
      const alpha = clamp(life / 15, 0, 1);
      ctx.beginPath();
      ctx.strokeStyle = f.caught ? `rgba(214,69,69,${alpha})` : `rgba(224,167,46,${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.arc(f.x, f.y, 10 + (15 - life), 0, Math.PI * 2);
      ctx.stroke();
    });
  }
}

// ---------- 패널 매니저 ----------
const panelsEl = document.getElementById("panels");
const dualToggle = document.getElementById("dualModeToggle");
var sims = [];

function mountPanels(dual) {
  sims.forEach(s => s.pause());
  panelsEl.classList.toggle("dual", dual);
  panelsEl.innerHTML = "";
  sims = [];

  const a = document.createElement("div");
  a.className = "panel";
  panelsEl.appendChild(a);
  sims.push(new LunchLineSim(a, "패널 A"));

  if (dual) {
    const b = document.createElement("div");
    b.className = "panel";
    panelsEl.appendChild(b);
    sims.push(new LunchLineSim(b, "패널 B"));
  }
}

dualToggle.addEventListener("change", () => mountPanels(dualToggle.checked));
mountPanels(false);
