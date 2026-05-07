const { App } = require('@slack/bolt');
const { getOrgData } = require('./salesforce');
require('dotenv').config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// =========================================================
// 🚀 [핵심 기술] 데이터 캐싱 & 슬랙 프로필 사진 매칭
// =========================================================
let sfUsersCache = []; 
let cacheTimestamp = 0; 
const CACHE_TTL = 5 * 60 * 1000; 

async function getSlackAvatars(client) {
  try {
    const result = await client.users.list();
    const avatarMap = {};
    
    result.members.forEach(member => {
      if (member.profile && member.profile.email) {
        avatarMap[member.profile.email] = member.profile.image_192; 
      }
    });
    return avatarMap;
  } catch (error) {
    console.error('슬랙 유저 목록 가져오기 에러:', error);
    return {};
  }
}

async function getCachedOrgData(client) {
  const now = Date.now();
  
  if (sfUsersCache.length === 0 || (now - cacheTimestamp > CACHE_TTL)) {
    console.log('⏳ 세일즈포스 & 슬랙에서 최신 데이터를 가져와 조립합니다...');
    
    const [sfData, slackAvatars] = await Promise.all([
      getOrgData(),
      getSlackAvatars(client)
    ]);

    sfUsersCache = sfData.map(user => {
      // ✨ [수정됨] 슬랙 사진이 없을 경우, 직원 이름으로 예쁜 기본 프로필 이미지를 자동 생성합니다!
      // URL 인코딩을 통해 한글 이름(홍길동)도 깨지지 않게 처리합니다.
      const defaultAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.Name)}&background=random&color=fff&size=192`;

      return {
        ...user,
        SlackAvatar: slackAvatars[user.Email] || defaultAvatar
      };
    });
    
    cacheTimestamp = now;
  } else {
    console.log('⚡️ 저장된 캐시 데이터를 사용합니다.');
  }
  return sfUsersCache;
}

// ---------------------------------------------------------
// 🎨 [공통 함수] App Home 화면을 그려주는 함수
// ---------------------------------------------------------
async function updateHomeView(client, userId, selectedDepartment = 'all') {
  const sfUsers = await getCachedOrgData(client); 

  const departments = [...new Set(sfUsers.map(u => u.Department).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  const filterOptions = [
    { "text": { "type": "plain_text", "text": "전체 보기" }, "value": "all" }
  ];

  departments.forEach(dept => {
    filterOptions.push({ "text": { "type": "plain_text", "text": dept }, "value": dept });
  });

  let filteredUsers = sfUsers;
  if (selectedDepartment !== 'all') {
    filteredUsers = sfUsers.filter(u => u.Department === selectedDepartment);
  }

  const userBlocks = filteredUsers.map(user => {
    const title = user.Title || '직책 없음';
    const dept = user.Department || '소속 없음';
    const userDataStr = JSON.stringify(user); 

    return {
      "type": "section",
      "text": { 
        "type": "mrkdwn", 
        "text": `*${user.Name}*\n${title} | ${dept}` 
      },
      "accessory": {
        "type": "button",
        "text": { "type": "plain_text", "text": "🔍 상세보기" },
        "value": userDataStr,
        "action_id": "open_user_modal"
      }
    };
  });

  if (userBlocks.length === 0) {
    userBlocks.push({
      "type": "section",
      "text": { "type": "mrkdwn", "text": "해당 부서에 등록된 직원이 없습니다." }
    });
  }

  await client.views.publish({
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        { "type": "header", "text": { "type": "plain_text", "text": "🏢 우리회사 조직도" } },
        {
          "type": "actions",
          "elements": [
            {
              "type": "static_select",
              "placeholder": { "type": "plain_text", "text": "부서 필터링..." },
              "options": filterOptions,
              "initial_option": filterOptions.find(opt => opt.value === selectedDepartment),
              "action_id": "filter_department"
            },
            // ✨ [새로 추가됨] 수동 새로고침 버튼
            {
              "type": "button",
              "text": { "type": "plain_text", "text": "🔄 최신 데이터 불러오기" },
              "style": "primary", // 파란색으로 강조
              "action_id": "refresh_data"
            }
          ]
        },
        { "type": "divider" },
        ...userBlocks 
      ]
    }
  });
}

// ---------------------------------------------------------
// 🚀 [이벤트 및 액션 핸들러]
// ---------------------------------------------------------

app.event('app_home_opened', async ({ event, client, logger }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          { "type": "header", "text": { "type": "plain_text", "text": "🏢 우리회사 조직도" } },
          { "type": "section", "text": { "type": "mrkdwn", "text": "\n\n⏳ *데이터를 동기화하는 중입니다...*\n\n" } }
        ]
      }
    });
    await updateHomeView(client, event.user, 'all');
  } catch (error) {
    logger.error('앱 홈 열기 에러:', error);
  }
});

app.action('filter_department', async ({ ack, body, client, logger }) => {
  await ack(); 
  try {
    const selectedDepartment = body.actions[0].selected_option.value;
    await updateHomeView(client, body.user.id, selectedDepartment);
  } catch (error) {
    logger.error('부서 필터링 에러:', error);
  }
});

// ✨ [새로 추가됨] 새로고침 버튼을 눌렀을 때 동작하는 로직
app.action('refresh_data', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    // 1. 사용자에게 먼저 로딩 화면을 보여줌
    await client.views.publish({
      user_id: body.user.id,
      view: {
        type: 'home',
        blocks: [
          { "type": "header", "text": { "type": "plain_text", "text": "🏢 우리회사 조직도" } },
          { "type": "section", "text": { "type": "mrkdwn", "text": "\n\n⏳ *세일즈포스에서 최신 데이터를 가져오는 중입니다...*\n\n" } }
        ]
      }
    });

    // 2. 강제로 캐시 바구니를 비워버림 (핵심!)
    sfUsersCache = [];
    cacheTimestamp = 0;

    // 3. 화면을 다시 그림 (캐시가 비었으므로 세일즈포스에 새로 접속하게 됨)
    await updateHomeView(client, body.user.id, 'all');
  } catch (error) {
    logger.error('새로고침 에러:', error);
  }
});

app.action('open_user_modal', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    const user = JSON.parse(body.actions[0].value);
    const address = [user.City, user.Street].filter(Boolean).join(' ') || '등록된 주소 없음';
    const managerName = user.Manager ? user.Manager.Name : '상급자 없음';
    const email = user.Email || '이메일 없음';
    const phone = user.Phone || '전화번호 없음';

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: `${user.Name} 프로필` },
        blocks: [
          {
            "type": "section",
            "text": { "type": "mrkdwn", "text": `*${user.Name}*\n${user.Title || '직책 없음'} | ${user.Department || '소속 없음'}` },
            "accessory": {
              "type": "image",
              "image_url": user.SlackAvatar,
              "alt_text": `${user.Name}의 프로필 사진`
            }
          },
          { "type": "divider" },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*이메일:*\n📧 ${email}` } },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*전화번호:*\n📞 ${phone}` } },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*상급자:*\n👤 ${managerName}` } },
          { "type": "section", "text": { "type": "mrkdwn", "text": `*근무지 주소:*\n📍 ${address}` } }
        ]
      }
    });
  } catch (error) {
    logger.error('팝업 띄우기 에러:', error);
  }
});

(async () => {
  // Render는 process.env.PORT라는 이름으로 포트 번호를 던져줍니다.
  // 이걸 받아서 실행해야 Render가 "아, 서버가 문을 열었구나!" 하고 안심합니다.
  const port = process.env.PORT || 3000;

  try {
    await app.start(port);
    console.log(`⚡️ 성공! 포트 ${port}번에서 봇이 활기차게 돌아갑니다!`);
  } catch (error) {
    console.error('❌ 봇 시작 에러:', error);
  }
})();
