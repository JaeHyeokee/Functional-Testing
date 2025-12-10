import fs from "fs";
import { chromium } from "playwright";

/* URL 및 계정정보 */
const URL = "http://oasys.co.kr:18080/";
const ID = "user1";
const PW = "User123!@#";

/* 필요한 요소들의 Selectors */
const SELECTOR = {
  idInput: '//input[@type="text" and @title="아이디를 입력하세요."]',
  pwInput: '//input[@type="password" and @title="비밀번호를 입력하세요."]',
  loginBtn: '//div[@role="button" and .//div[text()="Login"]]',

  rightMenu: '.right-button-type-common .cl-text',
  topMenu: '.cl-navigationbar .cl-navigationbar-item',
  leftMenu: '.cl-accodion-header, .cl-tree-item',

  searchBtn: '//div[@role="button"]//div[text()="조회"]',
  closeAllTabsBtn: 'div[title="모든 탭 닫기"]',
};

/**
 * 정규식 내 특수문자 충돌 방지용
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * 로그인
 */
async function login(page) {
  await page.goto(URL);
  await page.fill(SELECTOR.idInput, ID);
  await page.fill(SELECTOR.pwInput, PW);
  await page.click(SELECTOR.loginBtn);
  await page.waitForLoadState("networkidle");
}

/**
 * 우측 사이드 메뉴 클릭
 * @param {*} name 메뉴명
 */
async function clickRightSideMenu(page, name) {
  const safe = new RegExp(`^${escapeRegex(name).replace(/\s+/g, "[\\s\\n\\r]+")}$`, "m"); // m: multiline
  await page.getByRole("button", { name: safe }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(100);
}

/**
 * 상단 사이드 메뉴 클릭
 * @param {*} name 메뉴명
 */
async function clickTopMenu(page, name) {
  await page.locator(`${SELECTOR.topMenu}:has-text("${name}")`).click();
  await page.waitForTimeout(100);
}

/**
 * 아코디언 패널 내부 모든 후손 탐색
 */
async function getAccordionChildren(el, page) {
  await el.click();
  await page.waitForTimeout(200);

  const panelHandle = await el.evaluateHandle(node => node.nextElementSibling);
  const panelEl = panelHandle.asElement();
  if (!panelEl) return [];

  const childrenEls = await panelEl.$$(':scope .cl-text');
  const children = [];
  for (const child of childrenEls) {
    const text = (await child.innerText()).trim();
    if (text) children.push({ name: text, el: child });
  }
  return children;
}

/**
 * 트리 메뉴 재귀
 */
async function getTreeChildren(treeEl) {
  const result = [];
  const subItems = await treeEl.$$('.cl-tree-item');

  for (const sub of subItems) {
    const textEl = await sub.$('.cl-text');
    const text = (await textEl.innerText()).trim();
    const children = await getTreeChildren(sub);
    result.push(children.length > 0 ? { name: text, children, el: sub } : { name: text, el: sub });
  }
  return result;
}

/**
 * 좌측 메뉴 재귀 탐색
 */
async function getLeftMenuTree(page) {
  const tree = [];
  const topItems = await page.$$(SELECTOR.leftMenu);

  for (const el of topItems) {
    const text = (await el.innerText()).trim();
    let children = [];
    const className = await el.evaluate(node => node.className);

    if (className.includes('cl-accodion-header')) {
      children = await getAccordionChildren(el, page);
    } else if (className.includes('cl-tree-item')) {
      children = await getTreeChildren(el);
    }

    tree.push(children.length > 0 ? { name: text, children, el } : { name: text, el });
  }
  return tree;
}

/**
 * 좌측 사이드 메뉴 클릭
 * @param {*} node 메뉴명
 */
async function clickLeftMenuTree(page, node) {
  await node.el.click();
  await node.el.evaluate(el => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(100);

  if (node.children) {
    for (const child of node.children) {
      await clickLeftMenuTree(page, child);
    }
  }
}

async function pressSearch(page) {
  try {
    const searchBtn = page.locator(SELECTOR.searchBtn);
    if (await searchBtn.count() > 0) {
      await searchBtn.waitFor({ state: 'visible', timeout: 3000 });
      await searchBtn.click();
      console.log("✅ 조회 버튼 클릭 성공");
      await page.waitForTimeout(3000); // 클릭 후 잠시 대기
    } else {
      console.log("⚠️ 조회 버튼을 찾을 수 없음");
    }
  } catch (e) {
    console.log("⚠️ 조회 버튼 클릭 실패:", e.message);
  }
}

/**
 * 모든 탭 닫기 클릭
 */
async function closeAllTabs(page) {
  try {
    const btn = page.locator(SELECTOR.closeAllTabsBtn);
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForTimeout(100); // 닫힌 후 잠시 대기
    }
  } catch (e) {
    console.log("⚠️ 전체 탭 닫기 실패:", e.message);
  }
}

function extractSensitiveText(text) {
  const patterns = {
    corpReg: /\d{6}-\d{7}/g,
    bizReg: /\d{3}-\d{2}-\d{5}/g,
    personal: /\d{6}-\d{7}/g, // 주민번호 패턴
  };

  let detected = {};

  for (let key in patterns) {
    const found = text.match(patterns[key]);
    if (found) detected[key] = found;
  }

  return detected;
}

async function scanPageForSensitiveData(page) {
  const text = await page.innerText("body");
  return extractSensitiveText(text);
}

/**
 * 전체 프로세스 실행
 */
async function run() {
  const browser = await chromium.launch({
    headless: false, // 브라우저 창 띄우기
    args: ['--start-maximized'] // 최대화 옵션
  });
  const context = await browser.newContext({
    viewport: null // null로 하면 브라우저 창 크기 그대로 사용
  });
  const page = await context.newPage();

  // ✅ HTTPS 요청 차단 (가장 먼저 등록)
  await page.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith("https://")) return route.abort();
    route.continue();
  });

  await login(page);

  const rightMenus = await page.$$eval(SELECTOR.rightMenu, els => els.map(e => e.textContent.trim()));
  const results = {};

  for (const side of rightMenus) {
    console.log(`\n===== 우측 사이드메뉴: ${side} =====`);
    results[side] = {};

    // if (side === '보고서') continue;

    await clickRightSideMenu(page, side);

    const topMenus = await page.$$eval(SELECTOR.topMenu, els =>
      els.map(e => e.innerText.trim()).filter(t => t.length > 0)
    );
    results[side]["topMenus"] = topMenus;

    for (const top of topMenus) {
      console.log(`  ▶ TopMenu: ${top}`);
      results[side][top] = [];

      await clickTopMenu(page, top);

      const leftMenuTree = await getLeftMenuTree(page);

      for (const node of leftMenuTree) {
        console.log(`     → Left: ${node.name}`);

        await clickLeftMenuTree(page, node);
        await pressSearch(page);

        const sensitive = await scanPageForSensitiveData(page);
        if (Object.keys(sensitive).length > 0) {
          console.log(`        ⚠️ 민감데이터 발견:`, sensitive);
        }

        // ✅ 테스트 후 탭 닫기
        await closeAllTabs(page);
      }
    }
  }

  fs.writeFileSync("scanResult.json", JSON.stringify(results, null, 2));
  console.log("결과 저장 완료 → scanResult.json");

  await browser.close();
}

run();
