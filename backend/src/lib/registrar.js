'use strict';
const config = require('../config');

/*
  Hook for the school's official student database / registrar records.

  Today (REGISTRAR_MODE=manual) nothing is looked up: an administrator checks each student by hand and
  approves or rejects them. When the school provides an API, implement the lookup below and set
  REGISTRAR_MODE=api + REGISTRAR_API_URL. Its answer is shown to the admin next to the request; it never
  verifies anyone automatically on its own.

  Return shape: { available: boolean, enrolled: true | false | null, source: string, detail?: string }
*/
async function checkEnrollment(student) { // eslint-disable-line no-unused-vars
  if (config.registrar.mode !== 'api' || !config.registrar.url) {
    return { available: false, enrolled: null, source: 'manual', detail: 'No registrar integration is connected. Check the student against school records by hand.' };
  }
  // TODO(registrar): call config.registrar.url with student.school_id / name and map the response here.
  return { available: false, enrolled: null, source: 'api', detail: 'REGISTRAR_MODE=api is set but the lookup is not implemented yet.' };
}

module.exports = { checkEnrollment };
