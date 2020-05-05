/**
 * Lifted from https://github.com/jfromaniello/url-join/blob/master/lib/url-join.js
 *
 * Stripped out several things including:
 *  - handling of file protocol (file://)
 *  - handling of normal protocol (http(s):// etc)
 *  - trailing slashes before ? / # etc. We want these symbols for express routes potentially
 *  - Replacing ? with & again with regexes in express we may want these.
 *
 *  This leaves it really only handling combing two path fragments together which is what I want.
 */
export function urlPathJoin(strArray: string[]): string {
  const resultArray = [];
  if (strArray.length === 0) {
    return '';
  }

  for (let i = 0; i < strArray.length; i++) {
    let component = strArray[i];

    if (typeof component !== 'string') {
      throw new TypeError(`Url must be a string. Received ${  component}`);
    }

    if (component === '') {
      continue;
    }

    if (i > 0) {
      // Removing the starting slashes for each component but the first.
      component = component.replace(/^[\/]+/, '');
    }

    if (i < strArray.length - 1) {
      // Removing the ending slashes for each component but the last.
      component = component.replace(/[\/]+$/, '');
    } else {
      // For the last component we will combine multiple slashes to a single one.
      component = component.replace(/[\/]+$/, '/');
    }

    resultArray.push(component);

  }

  const str = resultArray.join('/');
  return str;
}