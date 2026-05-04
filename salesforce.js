const jsforce = require('jsforce');
require('dotenv').config();

// 세일즈포스 연결 객체 생성 (기본 로그인 URL)
// 만약 Sandbox 환경을 쓰신다면 'https://test.salesforce.com' 으로 변경하세요.
const conn = new jsforce.Connection({
  loginUrl: 'https://login.salesforce.com' 
});

async function getOrgData() {
  try {
    console.log('⏳ 세일즈포스에 로그인을 시도합니다...');
    
    // 환경변수에서 아이디와 (비밀번호+토큰)을 가져와 로그인
    // 토큰을 비워두었으므로 비밀번호만으로 로그인됩니다.
    await conn.login(
      process.env.SF_USERNAME, 
      process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN
    );
    console.log('✅ 세일즈포스 로그인 성공!');

    // SOQL 쿼리를 사용해 필요한 유저 데이터를 가져옵니다.
    // 활성화된 유저(IsActive=true) 중 이름, 직함, 부서, 매니저ID 등을 가져옵니다.
    
    const query = "SELECT Id, Name, Department,Title, Email, Phone, City, Street, Manager.Name FROM User WHERE IsActive = true";
    const result = await conn.query(query);

    console.log(`✅ 총 ${result.totalSize}명의 유저 데이터를 가져왔습니다.`);
    return result.records;

  } catch (error) {
    console.error('❌ 세일즈포스 연결 또는 쿼리 실패:', error);
    return [];
  }
}

// 다른 파일(app.js)에서 이 함수를 쓸 수 있게 내보냅니다.
module.exports = { getOrgData };

