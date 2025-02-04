import { template as _$template } from "r-dom";
import { wrap as _$wrap } from "r-dom";

const _tmpl$ = _$template(`<div>First</div>`),
      _tmpl$2 = _$template(`<div>Last</div>`),
      _tmpl$3 = _$template(`<div></div>`);

const multiStatic = [_tmpl$.cloneNode(true), _tmpl$2.cloneNode(true)];
const multiExpression = [_tmpl$.cloneNode(true), inserted, _tmpl$2.cloneNode(true)];
const multiDynamic = [(() => {
  const _el$5 = _tmpl$.cloneNode(true);

  _$wrap(() => _el$5.id = state.first);

  return _el$5;
})(), () => state.inserted, (() => {
  const _el$6 = _tmpl$2.cloneNode(true);

  _$wrap(() => _el$6.id = state.last);

  return _el$6;
})()];
const singleExpression = [inserted];
const singleDynamic = [() => inserted()];
const firstStatic = [inserted, _tmpl$3.cloneNode(true)];
const firstDynamic = [() => inserted(), _tmpl$3.cloneNode(true)];
const firstComponent = [Component({}), _tmpl$3.cloneNode(true)];
const lastStatic = [_tmpl$3.cloneNode(true), inserted];
const lastDynamic = [_tmpl$3.cloneNode(true), () => inserted()];
const lastComponent = [_tmpl$3.cloneNode(true), Component({})];