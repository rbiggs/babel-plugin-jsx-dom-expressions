const template = (
  <div id="main" classList={{ selected: selected }} style={{ color }}>
    <h1
      {...results}
      disabled
      title={welcoming()}
      style={{ backgroundColor: color() }}
      classList={{ selected: selected() }}
    >
      <a href={"/"} ref={link}>
        Welcome
      </a>
    </h1>
  </div>
);

const template2 = (
  <div>
    <div textContent={rowId} />
    <div textContent={row.label} />
  </div>
);
