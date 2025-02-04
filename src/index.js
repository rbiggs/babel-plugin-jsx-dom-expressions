import SyntaxJSX from "@babel/plugin-syntax-jsx";
import { addNamed } from "@babel/helper-module-imports";
import {
  Attributes,
  SVGAttributes,
  NonComposedEvents,
  SVGElements
} from "dom-expressions";
import VoidElements from "./VoidElements";

export default babel => {
  const { types: t } = babel;
  let moduleName = "dom",
    generate = "dom",
    delegateEvents = true,
    builtIns = [],
    alwaysCreateComponents = false,
    contextToCustomElements = false;

  // TODO: Consider using ast detection instead of raw string
  function isDynamic(jsx, path, checkTags) {
    const code = path.hub.file.code.slice(jsx.start, jsx.end).trim();
    return (
      !t.isFunction(jsx.expression) &&
      (code.includes(".") ||
        (code.includes("(") && code.includes(")")) ||
        (code.includes("[") && code.includes("]")) ||
        (checkTags && code.includes("<") && code.includes(">")))
    );
  }

  function registerImportMethod(path, name) {
    const imports =
      path.scope.getProgramParent().data.imports ||
      (path.scope.getProgramParent().data.imports = new Set());
    if (!imports.has(name)) {
      addNamed(path, name, moduleName, { nameHint: `_$${name}` });
      imports.add(name);
    }
  }

  function registerTemplate(path, results) {
    let decl;
    if (results.template.length) {
      const templates =
        path.scope.getProgramParent().data.templates ||
        (path.scope.getProgramParent().data.templates = []);
      let templateDef, templateId;
      if (
        (templateDef = templates.find(t => t.template === results.template))
      ) {
        templateId = templateDef.id;
      } else {
        templateId = path.scope.generateUidIdentifier("tmpl$");
        templates.push({
          id: templateId,
          template: results.template,
          isSVG: results.isSVG
        });
      }
      if (generate === "hydrate" || generate === "ssr")
        registerImportMethod(path, "getNextElement");
      decl = t.variableDeclarator(
        results.id,
        generate === "hydrate" || generate === "ssr"
          ? t.callExpression(t.identifier("_$getNextElement"), [templateId])
          : t.callExpression(
              t.memberExpression(templateId, t.identifier("cloneNode")),
              [t.booleanLiteral(true)]
            )
      );
    }
    results.decl.unshift(decl);
    results.decl = t.variableDeclaration("const", results.decl);
  }

  function toEventName(name) {
    return name.slice(2).toLowerCase();
  }

  function getTagName(tag) {
    if (t.isJSXMemberExpression(tag.openingElement.name)) {
      return `${tag.openingElement.name.object.name}.${tag.openingElement.name.property.name}`;
    } else if (t.isJSXIdentifier(tag.openingElement.name)) {
      return tag.openingElement.name.name;
    }
  }

  function setAttr(path, elem, name, value, isSVG, dynamic) {
    if (name === "style") {
      return t.callExpression(
        t.memberExpression(t.identifier("Object"), t.identifier("assign")),
        [t.memberExpression(elem, t.identifier(name)), value]
      );
    }

    if (name === "classList") {
      registerImportMethod(path, "classList");
      return t.callExpression(t.identifier("_$classList"), [elem, value]);
    }

    if (dynamic && name === "textContent") {
      return t.assignmentExpression(
        "=",
        t.memberExpression(elem, t.identifier("data")),
        value
      );
    }

    let isAttribute = isSVG || name.indexOf("-") > -1,
      attribute = isSVG ? SVGAttributes[name] : Attributes[name];

    if (attribute) {
      if (attribute.type === "attribute") isAttribute = true;
      if (attribute.alias) name = attribute.alias;
    } else if (isSVG)
      name = name.replace(/([A-Z])/g, g => `-${g[0].toLowerCase()}`);

    if (isAttribute)
      return t.callExpression(
        t.memberExpression(elem, t.identifier("setAttribute")),
        [t.stringLiteral(name), value]
      );
    return t.assignmentExpression(
      "=",
      t.memberExpression(elem, t.identifier(name)),
      value
    );
  }

  function wrapDynamics(path, dynamics) {
    if (!dynamics.length) return;
    registerImportMethod(path, "wrap");
    const results =
      dynamics.length === 1
        ? setAttr(
            path,
            dynamics[0].elem,
            dynamics[0].key,
            dynamics[0].value,
            dynamics[0].isSVG,
            true
          )
        : t.blockStatement(
            dynamics.map(({ elem, key, value, isSVG }) =>
              t.expressionStatement(
                setAttr(path, elem, key, value, isSVG, true)
              )
            )
          );

    return t.expressionStatement(
      t.callExpression(t.identifier("_$wrap"), [
        t.arrowFunctionExpression([], results)
      ])
    );
  }

  function createPlaceholder(path, results, tempPath, i, char) {
    const exprId = path.scope.generateUidIdentifier("el$");
    let contentId;
    results.template += `<!--${char}-->`;
    if (generate === "hydrate" && char === "/") {
      registerImportMethod(path, "getNextMarker");
      contentId = path.scope.generateUidIdentifier("co$");
      results.decl.push(
        t.variableDeclarator(
          t.arrayPattern([exprId, contentId]),
          t.callExpression(t.identifier("_$getNextMarker"), [
            t.memberExpression(
              t.identifier(tempPath),
              t.identifier("nextSibling")
            )
          ])
        )
      );
    } else
      results.decl.push(
        t.variableDeclarator(
          exprId,
          t.memberExpression(
            t.identifier(tempPath),
            t.identifier(i === 0 ? "firstChild" : "nextSibling")
          )
        )
      );
    return [exprId, contentId];
  }

  function nextChild(children, index) {
    return (
      children[index + 1] &&
      (children[index + 1].id || nextChild(children, index + 1))
    );
  }

  function trimWhitespace(text) {
    return text.replace(/[\r\n]\s*/g, "").replace(/\s+/g, " ");
  }

  function checkLength(children) {
    let i = 0;
    children.forEach(child => {
      !(
        t.isJSXExpressionContainer(child) &&
        t.isJSXEmptyExpression(child.expression)
      ) &&
        (!t.isJSXText(child) || !/^\s*$/.test(child.extra.raw)) &&
        i++;
    });
    return i > 1;
  }

  // remove unnecessary JSX Text nodes
  function filterChildren(children, loose) {
    return children.filter(
      child =>
        !(
          t.isJSXExpressionContainer(child) &&
          t.isJSXEmptyExpression(child.expression)
        ) &&
        (!t.isJSXText(child) ||
          (loose
            ? !/^[\r\n]\s*$/.test(child.extra.raw)
            : !/^\s*$/.test(child.extra.raw)))
    );
  }

  function transformComponentChildren(path, children, opts) {
    const filteredChildren = filterChildren(children);
    if (!filteredChildren.length) return;
    let dynamic;

    let transformedChildren = filteredChildren.map(child => {
      if (t.isJSXText(child)) {
        return t.stringLiteral(trimWhitespace(child.extra.raw));
      } else {
        child = generateHTMLNode(path, child, opts, { topLevel: true });
        if (child.id) {
          registerTemplate(path, child);
          if (
            !(child.exprs.length || child.dynamics.length) &&
            child.decl.declarations.length === 1
          )
            return child.decl.declarations[0].init;
          else
            return t.callExpression(
              t.arrowFunctionExpression(
                [],
                t.blockStatement([
                  child.decl,
                  ...child.exprs.concat(
                    wrapDynamics(path, child.dynamics) || []
                  ),
                  t.returnStatement(child.id)
                ])
              ),
              []
            );
        }
        return child.exprs[0];
      }
    });

    if (filteredChildren.length === 1) {
      transformedChildren = transformedChildren[0];
      if (t.isJSXExpressionContainer(filteredChildren[0]))
        dynamic = isDynamic(filteredChildren[0], path, true);
      else {
        transformedChildren =
          t.isCallExpression(transformedChildren) &&
          !transformedChildren.arguments.length
            ? transformedChildren.callee
            : t.arrowFunctionExpression([], transformedChildren);
        dynamic = true;
      }
    } else {
      transformedChildren = t.arrowFunctionExpression(
        [],
        t.arrayExpression(transformedChildren)
      );
      dynamic = true;
    }
    return [transformedChildren, dynamic];
  }

  // reduce unnecessary refs
  function detectExpressions(children, index) {
    if (children[index - 1]) {
      if (
        t.isJSXExpressionContainer(children[index - 1]) &&
        !t.isJSXEmptyExpression(children[index - 1].expression)
      )
        return true;
      let tagName;
      if (
        t.isJSXElement(children[index - 1]) &&
        (tagName = getTagName(children[index - 1])) &&
        tagName.toLowerCase() !== tagName
      )
        return true;
    }
    for (let i = index; i < children.length; i++) {
      if (t.isJSXExpressionContainer(children[i])) {
        if (!t.isJSXEmptyExpression(children[i].expression)) return true;
      } else if (t.isJSXElement(children[i])) {
        const tagName = getTagName(children[i]);
        if (tagName.toLowerCase() !== tagName) return true;
        if (
          contextToCustomElements &&
          (tagName === "slot" || tagName.indexOf("-") > -1)
        )
          return true;
        if (
          children[i].openingElement.attributes.some(
            attr =>
              t.isJSXSpreadAttribute(attr) ||
              t.isJSXExpressionContainer(attr.value)
          )
        )
          return true;
        const nextChildren = filterChildren(children[i].children, true);
        if (nextChildren.length)
          if (detectExpressions(nextChildren, 0)) return true;
      }
    }
  }

  function generateComponent(path, jsx, opts) {
    let props = [],
      runningObject = [],
      exprs,
      tagName = getTagName(jsx),
      dynamicKeys = [];

    if (builtIns.indexOf(tagName) > -1) {
      registerImportMethod(path, tagName);
      tagName = `_$${tagName}`;
    }

    jsx.openingElement.attributes.forEach(attribute => {
      if (t.isJSXSpreadAttribute(attribute)) {
        if (runningObject.length) {
          props.push(t.objectExpression(runningObject));
          runningObject = [];
        }
        const key = t.identifier("k$"),
          memo = t.identifier("m$");
        dynamicKeys.push(
          t.spreadElement(
            t.callExpression(
              t.memberExpression(t.identifier("Object"), t.identifier("keys")),
              [attribute.argument]
            )
          )
        );
        props.push(
          t.callExpression(
            t.memberExpression(
              t.callExpression(
                t.memberExpression(
                  t.identifier("Object"),
                  t.identifier("keys")
                ),
                [attribute.argument]
              ),
              t.identifier("reduce")
            ),
            [
              t.arrowFunctionExpression(
                [memo, key],
                t.sequenceExpression([
                  t.assignmentExpression(
                    "=",
                    t.memberExpression(memo, key, true),
                    t.arrowFunctionExpression(
                      [],
                      t.memberExpression(attribute.argument, key, true)
                    )
                  ),
                  memo
                ])
              ),
              t.objectExpression([])
            ]
          )
        );
      } else {
        const value = attribute.value || t.booleanLiteral(true);
        if (t.isJSXExpressionContainer(value))
          if (attribute.name.name === "ref") {
            runningObject.push(
              t.objectProperty(
                t.identifier("ref"),
                t.arrowFunctionExpression(
                  [t.identifier("r$")],
                  t.assignmentExpression(
                    "=",
                    value.expression,
                    t.identifier("r$")
                  )
                )
              )
            );
          } else if (attribute.name.name === "forwardRef") {
            runningObject.push(
              t.objectProperty(t.identifier("ref"), value.expression)
            );
          } else if (isDynamic(value, path, true)) {
            dynamicKeys.push(t.stringLiteral(attribute.name.name));
            runningObject.push(
              t.objectProperty(
                t.identifier(attribute.name.name),
                t.arrowFunctionExpression([], value.expression)
              )
            );
          } else
            runningObject.push(
              t.objectProperty(
                t.identifier(attribute.name.name),
                value.expression
              )
            );
        else
          runningObject.push(
            t.objectProperty(t.identifier(attribute.name.name), value)
          );
      }
    });

    const childResult = transformComponentChildren(path, jsx.children, opts);
    if (childResult && childResult[0]) {
      childResult[1] && dynamicKeys.push(t.stringLiteral("children"));
      runningObject.push(
        t.objectProperty(t.identifier("children"), childResult[0])
      );
    }
    props.push(t.objectExpression(runningObject));

    if (props.length > 1)
      props = [
        t.callExpression(
          t.memberExpression(t.identifier("Object"), t.identifier("assign")),
          props
        )
      ];

    if (alwaysCreateComponents || dynamicKeys.length) {
      registerImportMethod(path, "createComponent");
      exprs = [
        t.callExpression(t.identifier("_$createComponent"), [
          t.identifier(tagName),
          props[0],
          t.arrayExpression(dynamicKeys)
        ])
      ];
    } else exprs = [t.callExpression(t.identifier(tagName), props)];

    return { exprs, template: "", component: true };
  }

  function transformAttributes(path, jsx, results) {
    let elem = results.id;
    const spread = t.identifier("_$spread"),
      tagName = getTagName(jsx),
      isSVG = SVGElements.has(tagName);
    jsx.openingElement.attributes.forEach(attribute => {
      if (t.isJSXSpreadAttribute(attribute)) {
        registerImportMethod(path, "spread");
        results.exprs.push(
          t.expressionStatement(
            t.callExpression(spread, [
              elem,
              t.arrowFunctionExpression([], attribute.argument),
              t.booleanLiteral(isSVG)
            ])
          )
        );
        return;
      }

      let value = attribute.value,
        key = attribute.name.name;
      if (t.isJSXExpressionContainer(value)) {
        if (key === "ref") {
          results.exprs.unshift(
            t.expressionStatement(
              t.assignmentExpression("=", value.expression, elem)
            )
          );
        } else if (key === "forwardRef") {
          results.exprs.unshift(
            t.expressionStatement(
              t.logicalExpression(
                "&&",
                value.expression,
                t.callExpression(value.expression, [elem])
              )
            )
          );
        } else if (key.startsWith("on")) {
          const ev = toEventName(key);
          if (
            delegateEvents &&
            key !== key.toLowerCase() &&
            !NonComposedEvents.has(ev)
          ) {
            const events =
              path.scope.getProgramParent().data.events ||
              (path.scope.getProgramParent().data.events = new Set());
            events.add(ev);
            results.exprs.unshift(
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(
                    t.identifier(elem.name),
                    t.identifier(`__${ev}`)
                  ),
                  value.expression
                )
              )
            );
          } else
            results.exprs.unshift(
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(
                    t.identifier(elem.name),
                    t.identifier(`on${ev}`)
                  ),
                  value.expression
                )
              )
            );
        } else if (key === "events") {
          value.expression.properties.forEach(prop =>
            results.exprs.push(
              t.expressionStatement(
                t.callExpression(
                  t.memberExpression(elem, t.identifier("addEventListener")),
                  [t.stringLiteral(prop.key.name || prop.key.value), prop.value]
                )
              )
            )
          );
        } else if (isDynamic(value, path)) {
          if (key === "textContent") {
            const textId = path.scope.generateUidIdentifier("el$");
            results.exprs.push(
              t.expressionStatement(
                t.assignmentExpression(
                  "=",
                  t.memberExpression(elem, t.identifier("textContent")),
                  value.expression
                )
              ),
              t.variableDeclaration("const", [
                t.variableDeclarator(
                  textId,
                  t.memberExpression(elem, t.identifier("firstChild"))
                )
              ])
            );
            elem = textId;
          }
          results.dynamics.push({ elem, key, value: value.expression, isSVG });
        } else {
          results.exprs.push(
            t.expressionStatement(
              setAttr(path, elem, key, value.expression, isSVG)
            )
          );
        }
      } else {
        if (isSVG) {
          attribute = SVGAttributes[key];

          if (attribute) {
            if (attribute.alias) key = attribute.alias;
          } else key = key.replace(/([A-Z])/g, g => `-${g[0].toLowerCase()}`);
        } else {
          attribute = SVGAttributes[key];
          if (attribute && attribute.alias) key = attribute.alias;
        }
        results.template += ` ${key}`;
        results.template += value ? `="${value.value}"` : `=""`;
      }
    });
  }

  function transformChildren(path, jsx, opts, results) {
    let tempPath = results.id && results.id.name,
      i = 0;
    const jsxChildren = filterChildren(jsx.children, true),
      children = jsxChildren.map((jsxChild, index) =>
        generateHTMLNode(path, jsxChild, opts, {
          skipId: !results.id || !detectExpressions(jsxChildren, index)
        })
      );

    children.forEach((child, index) => {
      if (!child) return;
      results.template += child.template;
      if (child.id) {
        results.decl.push(
          t.variableDeclarator(
            child.id,
            t.memberExpression(
              t.identifier(tempPath),
              t.identifier(i === 0 ? "firstChild" : "nextSibling")
            )
          )
        );
        results.decl.push(...child.decl);
        results.exprs.push(...child.exprs);
        results.dynamics.push(...child.dynamics);
        tempPath = child.id.name;
        i++;
      } else if (child.exprs.length) {
        registerImportMethod(path, "insert");
        if (generate === "hydrate") registerImportMethod(path, "hydration");
        const multi = checkLength(jsxChildren),
          markers = (generate === "ssr" || generate === "hydrate") && multi;
        // boxed by textNodes
        if (
          markers ||
          (t.isJSXText(jsxChildren[index - 1]) &&
            t.isJSXText(jsxChildren[index + 1]))
        ) {
          if (markers)
            tempPath = createPlaceholder(path, results, tempPath, i++, "#")[0]
              .name;
          const [exprId, contentId] = createPlaceholder(
            path,
            results,
            tempPath,
            i++,
            markers ? "/" : ""
          );
          const insertExpr = t.callExpression(
            t.identifier("_$insert"),
            contentId
              ? [results.id, child.exprs[0], exprId, contentId]
              : [results.id, child.exprs[0], exprId]
          );
          results.exprs.push(
            t.expressionStatement(
              contentId
                ? t.callExpression(t.identifier("_$hydration"), [
                    t.arrowFunctionExpression([], insertExpr),
                    results.id
                  ])
                : insertExpr
            )
          );
          tempPath = exprId.name;
        } else if (multi) {
          results.exprs.push(
            t.expressionStatement(
              t.callExpression(t.identifier("_$insert"), [
                results.id,
                child.exprs[0],
                nextChild(children, index) || t.nullLiteral()
              ])
            )
          );
        } else {
          const insertExpr = t.callExpression(
            t.identifier("_$insert"),
            generate === "hydrate"
              ? [
                  results.id,
                  child.exprs[0],
                  t.identifier("undefined"),
                  t.callExpression(
                    t.memberExpression(
                      t.memberExpression(
                        t.memberExpression(
                          t.identifier("Array"),
                          t.identifier("prototype")
                        ),
                        t.identifier("slice")
                      ),
                      t.identifier("call")
                    ),
                    [
                      t.memberExpression(
                        results.id,
                        t.identifier("childNodes")
                      ),
                      t.numericLiteral(0)
                    ]
                  )
                ]
              : [results.id, child.exprs[0]]
          );
          results.exprs.push(
            t.expressionStatement(
              generate === "hydrate"
                ? t.callExpression(t.identifier("_$hydration"), [
                    t.arrowFunctionExpression([], insertExpr),
                    results.id
                  ])
                : insertExpr
            )
          );
        }
      }
    });
  }

  function transformFragmentChildren(path, jsx, opts, results) {
    const jsxChildren = filterChildren(jsx.children, true),
      children = jsxChildren.map(child => {
        if (t.isJSXText(child)) {
          return t.stringLiteral(trimWhitespace(child.extra.raw));
        } else {
          child = generateHTMLNode(path, child, opts, { topLevel: true });
          if (child.id) {
            registerTemplate(path, child);
            if (
              !(child.exprs.length || child.dynamics.length) &&
              child.decl.declarations.length === 1
            )
              return child.decl.declarations[0].init;
            else
              return t.callExpression(
                t.arrowFunctionExpression(
                  [],
                  t.blockStatement([
                    child.decl,
                    ...child.exprs.concat(
                      wrapDynamics(path, child.dynamics) || []
                    ),
                    t.returnStatement(child.id)
                  ])
                ),
                []
              );
          }
          return child.exprs[0];
        }
      });
    results.exprs.push(t.arrayExpression(children));
  }

  function generateHTMLNode(path, jsx, opts, info = {}) {
    if (t.isJSXElement(jsx)) {
      let tagName = getTagName(jsx),
        wrapSVG = info.topLevel && tagName != "svg" && SVGElements.has(tagName),
        voidTag = VoidElements.indexOf(tagName) > -1;
      if (tagName !== tagName.toLowerCase())
        return generateComponent(path, jsx, opts);
      let results = {
        template: `<${tagName}`,
        decl: [],
        exprs: [],
        dynamics: [],
        isSVG: wrapSVG
      };
      if (wrapSVG) results.template = "<svg>" + results.template;
      if (!info.skipId) results.id = path.scope.generateUidIdentifier("el$");
      transformAttributes(path, jsx, results);
      if (
        contextToCustomElements &&
        (tagName === "slot" || tagName.indexOf("-") > -1)
      ) {
        registerImportMethod(path, "currentContext");
        results.exprs.push(
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(results.id, t.identifier("_context")),
              t.callExpression(t.identifier("_$currentContext"), [])
            )
          )
        );
      }
      results.template += ">";
      if (!voidTag) {
        transformChildren(path, jsx, opts, results);
        results.template += `</${tagName}>`;
      }
      if (wrapSVG) results.template += "</svg>";
      return results;
    } else if (t.isJSXFragment(jsx)) {
      let results = { template: "", decl: [], exprs: [], dynamics: [] };
      transformFragmentChildren(path, jsx, opts, results);
      return results;
    } else if (t.isJSXText(jsx)) {
      const text = trimWhitespace(jsx.extra.raw);
      if (!text.length) return null;
      const results = { template: text, decl: [], exprs: [], dynamics: [] };
      if (!info.skipId) results.id = path.scope.generateUidIdentifier("el$");
      return results;
    } else if (t.isJSXExpressionContainer(jsx)) {
      if (t.isJSXEmptyExpression(jsx.expression)) return null;
      if (!isDynamic(jsx, path))
        return { exprs: [jsx.expression], template: "" };
      return {
        exprs: [t.arrowFunctionExpression([], jsx.expression)],
        template: ""
      };
    }
  }

  return {
    name: "ast-transform",
    inherits: SyntaxJSX,
    visitor: {
      JSXElement: (path, { opts }) => {
        if ("moduleName" in opts) moduleName = opts.moduleName;
        if ("generate" in opts) generate = opts.generate;
        if ("delegateEvents" in opts) delegateEvents = opts.delegateEvents;
        if ("contextToCustomElements" in opts)
          contextToCustomElements = opts.contextToCustomElements;
        if ("alwaysCreateComponents" in opts)
          alwaysCreateComponents = opts.alwaysCreateComponents;
        if ("builtIns" in opts) builtIns = opts.builtIns;
        const result = generateHTMLNode(path, path.node, opts, {
          topLevel: true
        });
        if (result.id) {
          registerTemplate(path, result);
          if (
            !(result.exprs.length || result.dynamics.length) &&
            result.decl.declarations.length === 1
          )
            path.replaceWith(result.decl.declarations[0].init);
          else
            path.replaceWithMultiple(
              [result.decl].concat(
                result.exprs,
                wrapDynamics(path, result.dynamics) || [],
                t.returnStatement(result.id)
              )
            );
        } else path.replaceWith(result.exprs[0]);
      },
      JSXFragment: (path, { opts }) => {
        if ("moduleName" in opts) moduleName = opts.moduleName;
        if ("generate" in opts) generate = opts.generate;
        if ("delegateEvents" in opts) delegateEvents = opts.delegateEvents;
        if ("contextToCustomElements" in opts)
          contextToCustomElements = opts.contextToCustomElements;
        if ("alwaysCreateComponents" in opts)
          alwaysCreateComponents = opts.alwaysCreateComponents;
        if ("builtIns" in opts) builtIns = opts.builtIns;
        const result = generateHTMLNode(path, path.node, opts);
        path.replaceWith(result.exprs[0]);
      },
      Program: {
        exit: path => {
          if (path.scope.data.events) {
            registerImportMethod(path, "delegateEvents");
            path.node.body.push(
              t.expressionStatement(
                t.callExpression(t.identifier("_$delegateEvents"), [
                  t.arrayExpression(
                    Array.from(path.scope.data.events).map(e =>
                      t.stringLiteral(e)
                    )
                  )
                ])
              )
            );
          }
          if (path.scope.data.templates) {
            const declarators = path.scope.data.templates.map(template => {
              const tmpl = {
                cooked: template.template,
                raw: template.template
              };
              registerImportMethod(path, "template");
              return t.variableDeclarator(
                template.id,
                t.callExpression(
                  t.identifier("_$template"),
                  [
                    t.templateLiteral([t.templateElement(tmpl, true)], [])
                  ].concat(
                    template.isSVG ? t.booleanLiteral(template.isSVG) : []
                  )
                )
              );
            });
            path.node.body.unshift(t.variableDeclaration("const", declarators));
          }
        }
      }
    }
  };
};
