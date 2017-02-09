import React, { PropTypes } from 'react';

export default function ConsortiumResultMeta({
  computation,
  computationInputs,
  step,
  usernames,
}) {
  let covariates;
  let iterations;

  // TODO: Don't hard-code for inputs
  if (computation.name === 'decentralized-single-shot-ridge-regression') {
    covariates = computationInputs[0][1].map(x => x.name);
  } else {
    covariates = computationInputs[0][2].map(x => x.name);
    iterations = (
      <li>
        <strong>Iterations:</strong>
        {` ${step}`}
        <span className="text-muted">/{computationInputs[0][1]}</span>
      </li>
    );
  }

  return (
    <ul className="list-unstyled">
      <li>
        <strong>Computation:</strong>
        {' '}
        {computation.meta.name}
        {' '}
        <span className="text-muted">(Version {computation.version})</span>
      </li>
      {iterations}
      <li><strong>Covariates:</strong>{` ${covariates.join(', ')}`}</li>
      <li>
        <strong>Freesurfer ROI:</strong>
        {' '}
        {computationInputs[0][0].join(', ')}
      </li>
      <li><strong>Users:</strong>{` ${usernames.join(', ')}`}</li>
    </ul>
  );
}

ConsortiumResultMeta.displayName = 'ConsortiumResultMeta';

ConsortiumResultMeta.propTypes = {
  computation: PropTypes.shape({
    meta: PropTypes.shape({
      name: PropTypes.string.isRequired,
    }).isRequired,
    version: PropTypes.string.isRequired,
  }).isRequired,
  computationInputs: PropTypes.arrayOf(PropTypes.arrayOf(
    PropTypes.oneOfType([
      PropTypes.arrayOf(PropTypes.string),
      PropTypes.arrayOf(PropTypes.object),
      PropTypes.number,
    ])
  )).isRequired,
  step: PropTypes.number.isRequired,
  usernames: PropTypes.arrayOf(PropTypes.string).isRequired,
};