import * as path from 'path';
import * as pino from 'express-pino-logger';

import {
  ResourceDefinition,
  ResourceRouteDefinition,
  ResourceRouteHandlerBase,
  RouteContext,
  RouteMethod,
  UnthinkGeneratorBackend,
  ViewResult,
  DataResult, UnthinkViewRenderer, Cookie
} from '@epandco/unthink-foundation/lib/core';
import {
  Application,
  Router,
  RequestHandler,
  Request,
  Response,
  NextFunction,
  json,
  ErrorRequestHandler, CookieOptions
} from 'express';

interface GeneratedRoute {
  prefix: string;
  router: Router;
}

interface GeneratedDefinition {
  path: string;
  router: Router;
}

function setHeaders(resp: Response, headers?: Record<string, string>): void {
  if (!headers) {
    return;
  }

  for (const name in headers) {
    if (name.toLowerCase() === 'content-type') {
      console.log('skipping content-type - this cant be set directly');
      continue;
    }

    const currentValue = resp.getHeader(name);
    const newValue = headers[name];
    if (currentValue) {
      console.log(`Replacing header value for ${name}. Old: ${currentValue} - New: ${newValue}`);
    }
    
    resp.set(name, newValue);
  }
}

function setCookie(resp: Response, cookie: Cookie): void {
  const options: CookieOptions = {};

  /*
   * Noticed the 'cookie' function below did not like having a full object of undefined properties.
   * The type suggests this is fine but 'maxAge' specifically seems to trip up with the function assuming
   * that if the property exists, even if undefined (per the type) then it should be a number.
   *
   * This feels like a slight rough spot between where types are generated for express but it's obviously not
   * typescript under and they way they check for 'undefined' seems to be if property doesn't exist.
   *
   * The code below creates an empty object and only adds the property to it if the value exist for that property
   * to avoid the problem above.
   */
  if (cookie.domain) {
    options.domain = cookie.domain;
  }

  if (cookie.expires) {
    options.expires = cookie.expires;
  }

  if (cookie.httpOnly) {
    options.httpOnly = cookie.httpOnly;
  }

  if (cookie.maxAge) {
    options.maxAge = cookie.maxAge;
  }

  if (cookie.path) {
    options.path = cookie.path;
  }

  if (cookie.sameSite) {
    options.sameSite = cookie.sameSite;
  }

  if (cookie.secure) {
    options.secure = cookie.secure;
  }

  resp.cookie(cookie.name, cookie.value, options);
}

function setCookies(req: Request, resp: Response, cookies?: Cookie[]): void {
  if (!cookies) {
    return;
  }

  /* If cookies are set then lets not replace existing cookies unless specified by the new cookie config */
  if (req.cookies) {
    for (const cookie of cookies) {
      const currentCookie = req.cookies[cookie.name];

      if (currentCookie && !cookie.overwrite) {
        console.log(`Keep existing cookie: ${cookie.name} based on config option to overwrite this cookie.`);
        continue;
      }

      if (currentCookie && cookie.overwrite) {
        console.log(`Overwriting cookie: ${cookie.name} based on config option to overwrite this cookie.`);
      }

      setCookie(resp, cookie);
    }
  } else {
    /* probably not huge gains but lets not worry about the checks for existing cookies if not exist on the request */
    for (const cookie of cookies) {
      setCookie(resp, cookie);
    }
  }
}

function convertHeaders(req: Request): Record<string, string> | undefined {
  if (!req.headers) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  for (const name in req.headers) {
    const value = req.headers[name];

    if (value) {
      // Choosing to ignore the string[] part of this type definition.
      // Not clear why that is needed but can address it when it comes up.
      headers[name] = value as string;
    }
  }

  return headers;
}

function convertCookies(req: Request): Cookie[] | undefined {
  if (!req.cookies) {
    return undefined;
  }

  const cookies: Cookie[] = [];
  for (const name in req.cookies) {
    const value = req.cookies[name];

    cookies.push({
      name: name,
      value: value
    });
  }

  return cookies;
}

function buildViewHandler(resourceRouteHandler: ResourceRouteHandlerBase<ViewResult>, render: UnthinkViewRenderer): RequestHandler {
  return async (req, resp, next): Promise<void> => {
    resp.contentType('text/html');

    let error: unknown;
    try {
      const ctx: RouteContext = {
        query: req.query,
        params: req.params,
        headers: convertHeaders(req),
        cookies: convertCookies(req),
        logger: req.log
      };

      const result = await resourceRouteHandler(ctx);

      if (result.status === 200 && result.template) {
        const body = render(
          result.template as string,
          result.value
        );

        setHeaders(resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.status(200);
        resp.send(body);

        return;
      }

      if ((result.status === 301 || result.status === 302) && result.redirectUrl) {
        setHeaders(resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.redirect(result.status as number, result.redirectUrl as string);
        return;
      }

      if ((result.status === 301 || result.status === 302) && !result.redirectUrl) {
        error = new Error(`When view result has a status of ${result.status} the redirect url MUST BE specified`);
      } if (result.status === 200 && !result.template) {
        error = new Error('When view result has a status of 200 the template MUST BE set!');
      } else {
        error = result;
      }
    } catch (e) {
      error = e;
    }

    next(error);
  };
}

function buildViewErrorHandler(render: UnthinkViewRenderer): ErrorRequestHandler {
  return async (err: unknown, req: Request, resp: Response, _next: NextFunction ): Promise<void> => {
    if (resp.headersSent) {
      console.log('Response already sent. This is likely a bug in the route pipeline in this package.');
      return;
    }

    const unknownErrorMessage = 'Unknown error.';
    if (!err) {
      console.log('No error passed into handler');
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    if (!(err instanceof ViewResult)) {
      console.log('Unexpected error:', err);
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    const result = err as ViewResult;
    if (!result.template) {
      console.log('Template not defined.');
      resp.status(500).send(unknownErrorMessage);
      return;
    }

    try {
      const view = render(result.template as string, result.value);

      setHeaders(resp, result.headers);
      setCookies(req, resp, result.cookies);
      resp.status(result.status);
      resp.send(view);
      return;
    } catch (err) {
      console.log('Failed to handle result', err);
      resp.status(500).send(unknownErrorMessage);
    }
  };
}

function buildDataHandler(resourceRouteHandler: ResourceRouteHandlerBase<DataResult>): RequestHandler {
  return async (req, resp, next): Promise<void> => {
    let error: unknown;
    try {
      const ctx: RouteContext = {
        query: req.query,
        params: req.params,
        body: req.body,
        headers: convertHeaders(req),
        cookies: convertCookies(req),
        logger: req.log
      };

      const result = await resourceRouteHandler(ctx);

      if (result.status === 200 && result.value) {
        setHeaders(resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.status(result.status).json(result.value);
        return;
      }

      if (result.status === 204 && !result.value) {
        setHeaders(resp, result.headers);
        setCookies(req, resp, result.cookies);
        resp.status(204).end();
        return;
      }

      if (result.status === 200 && !result.value) {
        error = new Error('The value MUST be set for data results when the status is 200.');
      } else if (result.status === 201 && result.value) {
        error = new Error('The value SHOULD NOT be set for data results when the status is 204');
      } else {
        error = result;
      }
    } catch (e) {
      error = e;
    }

    next(error);
  };
}

async function dataErrorHandler(err: unknown, req: Request, resp: Response, _next: NextFunction ): Promise<void> {
  if (resp.headersSent) {
    console.log('Response already sent. This is likely a bug in the route pipeline in this package.');
    return;
  }

  const unknownError = 'Unknown error.';
  if (!err) {
    console.log('No error passed into handler');
    resp.status(500).json(unknownError);
    return;
  }

  if (!(err instanceof DataResult)) {
    console.log('Unexpected error:', err);
    resp.status(500).json(unknownError);
    return;
  }

  const result = err as DataResult;
  if (result.status !== 400 && result.status !== 401 && result.status !== 404) {
    console.log(`The status ${result.status} is not supported by this framework for data results.`);
    resp.status(500).json(unknownError);
    return;
  }

  if ((result.status === 401 || result.status === 404) && result.value) {
    console.log(`When the data result has a status of ${result.status} the value SHOULD NOT be set.`);
    resp.status(500).json('unknown error');
    return;
  }

  if (result.status === 400 && !result.value) {
    console.log('When the data result has a status of 400 the value should MUST be set.');
    resp.status(500).json('unknown error');
    return;
  }

  setHeaders(resp, result.headers);
  setCookies(req, resp, result.cookies);
  resp.status(result.status).json(result.value);
}

export class UnthinkExpressGenerator implements UnthinkGeneratorBackend<RequestHandler> {
  private readonly app: Application;
  private readonly viewRenderer: UnthinkViewRenderer;
  private readonly logLevel: string;

  constructor(app: Application, viewRenderer: UnthinkViewRenderer, logLevel: string) {
    this.app = app;
    this.viewRenderer = viewRenderer;
    this.logLevel = logLevel;
  }

  generate(resourceDefinitions: ResourceDefinition<RequestHandler>[]): void {
    const generatedDefinitions = resourceDefinitions.flatMap(p => this.generateDefinition(p));

    this.app.use(json());
    this.app.use(pino({
      level: this.logLevel
    }));

    for (const { path, router } of generatedDefinitions) {
      this.app.use(path, router);
    }
  }

  generateRoute(resourceRouteDefinition: ResourceRouteDefinition<RequestHandler>): GeneratedRoute {
    const router = Router();
    const route = router.route(resourceRouteDefinition.path);

    switch (resourceRouteDefinition.__routeType) {
    case 'DATA':
      router.use(dataErrorHandler);
      break;
    case 'VIEW':
      router.use(buildViewErrorHandler(this.viewRenderer));
      break;
    }

    if (resourceRouteDefinition.middleware && resourceRouteDefinition.middleware.length > 0) {
      route.all(...resourceRouteDefinition.middleware);
    }

    for (const method in resourceRouteDefinition.methods) {
      const resourceHandlerObj = resourceRouteDefinition.methods[method as RouteMethod];

      if (!resourceHandlerObj) {
        throw new Error('Handler must be defined.');
      }

      let resourceHandler: ResourceRouteHandlerBase;

      const handlers: RequestHandler[] = [];
      if ('handler' in resourceHandlerObj) {
        resourceHandler = resourceHandlerObj.handler;
        handlers.push(...resourceHandlerObj.middleware);
      } else {
        resourceHandler = resourceHandlerObj;
      }

      switch (resourceRouteDefinition.__routeType) {
      case 'DATA':
        handlers.push(
          buildDataHandler(resourceHandler as ResourceRouteHandlerBase<DataResult>)
        );
        break;
      case 'VIEW':
        handlers.push(
          buildViewHandler(
              resourceHandler as ResourceRouteHandlerBase<ViewResult>,
              this.viewRenderer
          )
        );
        break;
      }

      route[method as RouteMethod](...handlers);
    }

    return {
      prefix: resourceRouteDefinition.prefix ?? '',
      router: router
    };
  }

  generateDefinition(resourceDefinition: ResourceDefinition<RequestHandler>): GeneratedDefinition[] {
    const mapPrefixedRoutes = new Map<string, GeneratedDefinition>();

    for (const routeDef of resourceDefinition.routes) {
      const { prefix, router } = this.generateRoute(routeDef);

      if (!mapPrefixedRoutes.has(prefix)) {
        let basePath = resourceDefinition.basePath;

        if (!basePath) {
          console.log(`basePath is not defined for ${resourceDefinition.name} and being defaulted to '/'`);
          basePath = '/';
        }

        const urlPath = path.join(prefix, basePath);
        const generatedDefinition: GeneratedDefinition = {
          path: urlPath,
          router: Router()
        };

        if (resourceDefinition.middleware && resourceDefinition.middleware.length > 0) {
          generatedDefinition.router.use(...resourceDefinition.middleware);
        }

        mapPrefixedRoutes.set(prefix, generatedDefinition);
      }

      mapPrefixedRoutes.get(prefix)?.router.use(router);
    }

    return Array.from(mapPrefixedRoutes.values());
  }
}